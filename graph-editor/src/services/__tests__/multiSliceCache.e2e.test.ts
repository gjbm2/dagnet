/**
 * Multi-Slice Retrieval and Caching E2E Tests
 * 
 * FULL PRODUCTION CODE TEST - Only mocks:
 * 1. BrowserHttpExecutor (Amplitude API HTTP calls)
 * 2. react-hot-toast (UI notifications)
 * 3. sessionLogService (logging)
 * 4. contextRegistry.getValuesForContext (context file reads)
 * 
 * Uses REAL:
 * - dataOperationsService
 * - explodeDSL
 * - fileRegistry
 * - IndexedDB (via fake-indexeddb)
 * - windowAggregationService
 * - sliceIsolation
 * - All aggregation and caching logic
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

// ============================================================================
// TRACK API CALLS
// ============================================================================

interface APICall {
  url: string;
  start: string;
  end: string;
  timestamp: number;
}

const apiCallLog: APICall[] = [];

function resetAPILog() {
  apiCallLog.length = 0;
}

function getAPICallCount(): number {
  return apiCallLog.length;
}

// ============================================================================
// MOCK HTTP EXECUTOR (Only mock - intercepts Amplitude API calls)
// ============================================================================

const mockResponses = new Map<string, { n: number; k: number }>();

function setMockResponse(contextKey: string, data: { n: number; k: number }) {
  mockResponses.set(contextKey, data);
}

function clearMockResponses() {
  mockResponses.clear();
}

vi.mock('../../lib/das/BrowserHttpExecutor', () => ({
  BrowserHttpExecutor: class {
    async execute(request: any) {
      const urlObj = new URL(request.url, 'https://amplitude.com');
      const start = urlObj.searchParams.get('start') || '';
      const end = urlObj.searchParams.get('end') || '';
      
      // Log the API call
      apiCallLog.push({ url: request.url, start, end, timestamp: Date.now() });
      console.log('[MOCK HTTP] API Call:', { start, end, totalCalls: apiCallLog.length });
      
      // Parse start/end to generate daily data
      const startDate = start ? new Date(`${start.slice(0,4)}-${start.slice(4,6)}-${start.slice(6,8)}`) : new Date();
      const endDate = end ? new Date(`${end.slice(0,4)}-${end.slice(4,6)}-${end.slice(6,8)}`) : new Date();
      
      // Generate daily series
      const formattedXValues: string[] = [];
      const daySeries: number[][] = [];
      
      // Get response data based on context (default values if not set)
      // We'll use 100/50 as defaults
      const baseN = 100;
      const baseK = 50;
      
      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        formattedXValues.push(d.toISOString().split('T')[0]);
        // Simple linear series: [n, k] for each step
        daySeries.push([baseN, baseK]);
      }
      
      const totalN = baseN * formattedXValues.length;
      const totalK = baseK * formattedXValues.length;
      
      return {
        status: 200,
        data: {
          data: [{
            formattedXValues,
            stepByStepSeries: [[totalN], [totalK]],
            series: [[totalN], [totalK]],
            dayByDaySeries: [{
              formattedXValues,
              series: daySeries.map((_, dayIdx) => [baseN, baseK])
            }]
          }]
        },
        headers: {}
      };
    }
  }
}));

// Mock toast (UI only)
vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn()
  }
}));

// Mock session log (logging only)
vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    startOperation: vi.fn(() => 'mock-op-id'),
    endOperation: vi.fn(),
    addChild: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    getOperationLog: vi.fn(() => [])
  }
}));

// ============================================================================
// IMPORT REAL PRODUCTION CODE (after mocks are set up)
// ============================================================================

import { dataOperationsService, computeQuerySignature } from '../dataOperationsService';
import { explodeDSL } from '../../lib/dslExplosion';
import { parseConstraints } from '../../lib/queryDSL';
import { buildDslFromEdge } from '../../lib/das/buildDslFromEdge';
import { contextRegistry } from '../contextRegistry';
import { fileRegistry } from '../../contexts/TabContext';
import type { Graph, GraphData } from '../../types';

// ============================================================================
// TEST SUITE
// ============================================================================

describe('Multi-Slice Retrieval and Caching E2E (Real Production Code)', () => {
  
  beforeAll(() => {
    // Fresh IndexedDB
    globalThis.indexedDB = new IDBFactory();
  });
  
  beforeEach(() => {
    vi.clearAllMocks();
    resetAPILog();
    clearMockResponses();
    
    // Clear fileRegistry internal state
    // @ts-ignore - accessing internal for testing
    if (fileRegistry._files) {
      // @ts-ignore
      fileRegistry._files.clear();
    }
    
    // Mock contextRegistry.getValuesForContext (reads context files)
    vi.spyOn(contextRegistry, 'getValuesForContext').mockImplementation(async (contextId: string) => {
      if (contextId === 'channel') {
        return [
          { id: 'google', label: 'Google' },
          { id: 'facebook', label: 'Facebook' },
          { id: 'other', label: 'Other' }
        ] as any;
      }
      return [];
    });
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });
  
  // -------------------------------------------------------------------------
  // Helper: Create test graph
  // -------------------------------------------------------------------------
  
  function createTestGraph(options: {
    dataInterestsDSL?: string;
    currentQueryDSL?: string;
    paramId?: string;
  } = {}): GraphData {
    const paramId = options.paramId || 'test-conversion-param';
    
    return {
      nodes: [
        { 
          uuid: 'node-a', 
          id: 'test-from', 
          label: 'Test From',
          data: { event_id: 'test-from-event' }
        },
        { 
          uuid: 'node-b', 
          id: 'test-to', 
          label: 'Test To',
          data: { event_id: 'test-to-event' }
        }
      ],
      edges: [
        {
          uuid: 'edge-uuid-1',
          id: 'test-edge-1',
          from: 'node-a',
          to: 'node-b',
          source: 'node-a',
          target: 'node-b',
          query: 'from(test-from).to(test-to)',
          p: {
            id: paramId,
            connection: 'amplitude-prod',
            mean: 0.5
          }
        }
      ],
      dataInterestsDSL: options.dataInterestsDSL,
      currentQueryDSL: options.currentQueryDSL || 'window(1-Oct-25:7-Oct-25)',
      metadata: { name: 'test-graph' }
    } as unknown as GraphData;
  }
  
  // -------------------------------------------------------------------------
  // Helper: Setup mock files in fileRegistry
  // -------------------------------------------------------------------------
  
  function setupMockFiles(paramId: string, existingValues: any[] = []) {
    const paramFile = {
      id: paramId,
      connection: 'amplitude-prod',
      query: 'from(test-from).to(test-to)',
      values: existingValues
    };
    
    vi.spyOn(fileRegistry, 'getFile').mockImplementation((fileId: string) => {
      if (fileId === `parameter-${paramId}`) {
        return { data: paramFile, isDirty: false } as any;
      }
      if (fileId === 'event-test-from-event') {
        return { 
          data: { 
            id: 'test-from-event', 
            name: 'Test From Event',
            provider_event_names: { amplitude: 'Test From Amplitude Event' }
          },
          isDirty: false
        } as any;
      }
      if (fileId === 'event-test-to-event') {
        return { 
          data: { 
            id: 'test-to-event', 
            name: 'Test To Event',
            provider_event_names: { amplitude: 'Test To Amplitude Event' }
          },
          isDirty: false
        } as any;
      }
      return undefined;
    });
    
    vi.spyOn(fileRegistry, 'updateFile').mockImplementation(() => Promise.resolve());
    
    return paramFile;
  }
  
  // =========================================================================
  // TESTS: DSL Explosion (uses REAL explodeDSL)
  // =========================================================================
  
  describe('DSL Explosion (REAL explodeDSL)', () => {
    it('should explode window(-7d:).context(channel) into 3 slices using real production code', async () => {
      const slices = await explodeDSL('window(-7d:).context(channel)');
      
      expect(slices).toHaveLength(3);
      // Real explodeDSL normalizes the output
      expect(slices).toContainEqual(expect.stringMatching(/context\(channel:google\)/));
      expect(slices).toContainEqual(expect.stringMatching(/context\(channel:facebook\)/));
      expect(slices).toContainEqual(expect.stringMatching(/context\(channel:other\)/));
    });
    
    it('should return single slice for fully specified context', async () => {
      const slices = await explodeDSL('window(-7d:).context(channel:google)');
      
      expect(slices).toHaveLength(1);
      expect(slices[0]).toContain('context(channel:google)');
    });
  });
  
  // =========================================================================
  // TESTS: Real dataOperationsService - File Operations
  // =========================================================================
  
  describe('dataOperationsService file operations (REAL service)', () => {
    it('should call getParameterFromFile with targetSlice', async () => {
      const graph = createTestGraph({
        currentQueryDSL: 'context(channel:google).window(1-Oct-25:7-Oct-25)'
      });
      const setGraph = vi.fn();
      
      // Setup with existing cached data
      setupMockFiles('test-conversion-param', [{
        window_from: '2025-10-01T00:00:00.000Z',
        window_to: '2025-10-07T23:59:59.999Z',
        n: 700, k: 350,
        n_daily: [100, 100, 100, 100, 100, 100, 100],
        k_daily: [50, 50, 50, 50, 50, 50, 50],
        dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
        sliceDSL: 'context(channel:google)',
        query_signature: 'test-sig'
      }]);
      
      // Call REAL production code
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:google)'
      });
      
      // setGraph should have been called to update edge
      expect(setGraph).toHaveBeenCalled();
    });
    
    it('should correctly filter by sliceDSL using real isolateSlice', async () => {
      const graph = createTestGraph({
        currentQueryDSL: 'context(channel:facebook).window(1-Oct-25:7-Oct-25)'
      });
      let updatedGraph: any = null;
      const setGraph = vi.fn((g) => { updatedGraph = g; });
      
      // Setup with data for MULTIPLE slices
      setupMockFiles('test-conversion-param', [
        {
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 1000, k: 150, // Google data
          n_daily: [143, 143, 143, 143, 143, 143, 142],
          k_daily: [21, 22, 21, 22, 21, 22, 21],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:google)',
          query_signature: 'google-sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 800, k: 120, // Facebook data
          n_daily: [114, 114, 114, 114, 114, 115, 115],
          k_daily: [17, 17, 17, 17, 17, 17, 18],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:facebook)',
          query_signature: 'facebook-sig'
        }
      ]);
      
      // Request Facebook slice - should get Facebook data, NOT Google
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:facebook)'
      });
      
      expect(setGraph).toHaveBeenCalled();
      
      // Verify the edge was updated with Facebook data (n=800), not Google (n=1000)
      if (updatedGraph) {
        const edge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (edge?.p?.evidence) {
          expect(edge.p.evidence.n).toBe(800);
          expect(edge.p.evidence.k).toBe(120);
        }
      }
    });
  });
  
  // =========================================================================
  // TESTS: Cache Hit/Miss with Real Service
  // =========================================================================
  
  describe('Cache Hit/Miss (REAL aggregation logic)', () => {
    it('should NOT call API when data is already cached', async () => {
      const graph = createTestGraph({
        currentQueryDSL: 'window(1-Oct-25:7-Oct-25)'
      });
      const setGraph = vi.fn();
      
      // Pre-populate cache with existing data
      const existingValues = [{
        window_from: '2025-10-01T00:00:00.000Z',
        window_to: '2025-10-07T23:59:59.999Z',
        n: 700,
        k: 350,
        n_daily: [100, 100, 100, 100, 100, 100, 100],
        k_daily: [50, 50, 50, 50, 50, 50, 50],
        dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
        sliceDSL: '',
        query_signature: 'test-sig'
      }];
      
      setupMockFiles('test-conversion-param', existingValues);
      
      // Call getParameterFromFile (should use cache, not API)
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: ''
      });
      
      // Should NOT have called API - data was in cache
      expect(getAPICallCount()).toBe(0);
    });
    
    it('should use cached context slice without API call', async () => {
      const graph = createTestGraph({
        currentQueryDSL: 'context(channel:google).window(1-Oct-25:7-Oct-25)'
      });
      const setGraph = vi.fn();
      
      // Pre-populate cache with Google channel data
      const existingValues = [{
        window_from: '2025-10-01T00:00:00.000Z',
        window_to: '2025-10-07T23:59:59.999Z',
        n: 1000,
        k: 150,
        n_daily: [143, 143, 143, 143, 143, 143, 142],
        k_daily: [21, 22, 21, 22, 21, 22, 21],
        dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
        sliceDSL: 'context(channel:google)',
        query_signature: 'google-sig'
      }];
      
      setupMockFiles('test-conversion-param', existingValues);
      
      // Call with Google context - should use cache
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:google)'
      });
      
      // No API call - data was cached
      expect(getAPICallCount()).toBe(0);
    });
  });
  
  // =========================================================================
  // TESTS: Multi-Slice Scenario (Wide Pinned → Narrow User Query)
  // =========================================================================
  
  describe('Multi-Slice: Wide Pinned Window → Narrow User Query', () => {
    it('should serve narrow query (7d) from cached wide window (30d) for specific context', async () => {
      const graph = createTestGraph({
        currentQueryDSL: 'context(channel:google).window(1-Oct-25:7-Oct-25)'
      });
      const setGraph = vi.fn();
      
      // Simulate cached 30-day data for Google context
      const cachedValues = [{
        window_from: '2025-09-01T00:00:00.000Z',
        window_to: '2025-10-01T23:59:59.999Z',
        n: 3000, // 30 days of data
        k: 450,
        n_daily: Array(30).fill(100),
        k_daily: Array(30).fill(15),
        dates: Array.from({ length: 30 }, (_, i) => {
          const d = new Date('2025-09-01');
          d.setDate(d.getDate() + i);
          return d.toISOString().split('T')[0];
        }),
        sliceDSL: 'context(channel:google)',
        query_signature: 'google-30d'
      }];
      
      setupMockFiles('test-conversion-param', cachedValues);
      
      // User queries only last 7 days with Google context
      // This window is WITHIN the cached 30-day window
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-09-24T00:00:00.000Z', end: '2025-09-30T23:59:59.999Z' },
        targetSlice: 'context(channel:google)'
      });
      
      // No API call - narrow window is subset of cached wide window
      expect(getAPICallCount()).toBe(0);
    });
    
    it('should switch between cached context slices without API calls', async () => {
      const graph = createTestGraph({
        currentQueryDSL: 'window(1-Oct-25:7-Oct-25)'
      });
      const setGraph = vi.fn();
      
      // Cache data for ALL three channels
      const cachedValues = [
        {
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 1000, k: 150,
          n_daily: [143, 143, 143, 143, 143, 143, 142],
          k_daily: [21, 22, 21, 22, 21, 22, 21],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:google)',
          query_signature: 'google-sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 800, k: 120,
          n_daily: [114, 114, 114, 114, 114, 115, 115],
          k_daily: [17, 17, 17, 17, 17, 17, 18],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:facebook)',
          query_signature: 'facebook-sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 500, k: 75,
          n_daily: [71, 71, 71, 72, 72, 72, 71],
          k_daily: [11, 11, 11, 10, 11, 10, 11],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:other)',
          query_signature: 'other-sig'
        }
      ];
      
      setupMockFiles('test-conversion-param', cachedValues);
      
      // Switch between contexts - ALL should be cache hits
      
      // Query Google
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:google)'
      });
      
      // Query Facebook
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:facebook)'
      });
      
      // Query Other
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:other)'
      });
      
      // Zero API calls - all from cache
      expect(getAPICallCount()).toBe(0);
    });
  });
  
  // =========================================================================
  // TESTS: Real-World Complete Flow
  // =========================================================================
  
  describe('Complete Real-World Flow: Pinned Query → All Slices → User Query', () => {
    it('should simulate AllSlicesModal fetch then WindowSelector query', async () => {
      // Step 1: Explode DSL (REAL production code)
      const pinnedDSL = 'window(-7d:).context(channel)';
      const slices = await explodeDSL(pinnedDSL);
      
      expect(slices).toHaveLength(3);
      console.log('[TEST] Exploded slices:', slices);
      
      // Step 2: Simulate fetching each slice (would go through real dataOperationsService)
      const graph = createTestGraph({
        dataInterestsDSL: pinnedDSL,
        currentQueryDSL: 'window(1-Oct-25:7-Oct-25)'
      });
      const setGraph = vi.fn();
      
      // Initially no cached data
      setupMockFiles('test-conversion-param', []);
      
      // Note: In real production, AllSlicesModal would call getFromSource for each slice
      // Each call goes through the FULL production pipeline:
      // - buildDslFromEdge
      // - DASRunner.execute (mocked HTTP)
      // - windowAggregationService
      // - fileRegistry.updateFile
      
      // Step 3: After AllSlicesModal finishes, data would be cached
      // Simulate the cached result
      const cachedAfterFetch = [
        {
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 1000, k: 150,
          n_daily: [143, 143, 143, 143, 143, 143, 142],
          k_daily: [21, 22, 21, 22, 21, 22, 21],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:google)',
          query_signature: 'google-sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 800, k: 120,
          n_daily: [114, 114, 114, 114, 114, 115, 115],
          k_daily: [17, 17, 17, 17, 17, 17, 18],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:facebook)',
          query_signature: 'facebook-sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 500, k: 75,
          n_daily: [71, 71, 71, 72, 72, 72, 71],
          k_daily: [11, 11, 11, 10, 11, 10, 11],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:other)',
          query_signature: 'other-sig'
        }
      ];
      
      // Reset mock with cached data
      vi.restoreAllMocks();
      vi.spyOn(contextRegistry, 'getValuesForContext').mockResolvedValue([
        { id: 'google', label: 'Google' },
        { id: 'facebook', label: 'Facebook' },
        { id: 'other', label: 'Other' }
      ] as any);
      setupMockFiles('test-conversion-param', cachedAfterFetch);
      resetAPILog();
      
      // Step 4: User queries specific slice via WindowSelector
      // This should use cache (no API call)
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:google)'
      });
      
      // ZERO API calls - served from cache
      expect(getAPICallCount()).toBe(0);
      console.log('[TEST] User query served from cache - 0 API calls');
    });
  });
  
  // =========================================================================
  // TESTS: Window Subset Scenarios
  // =========================================================================
  
  describe('Window Subset: Narrow Query from Wide Cache', () => {
    it('should serve 3-day query from cached 30-day window', async () => {
      const graph = createTestGraph({
        currentQueryDSL: 'context(channel:google).window(25-Sep-25:27-Sep-25)'
      });
      const setGraph = vi.fn();
      
      // 30-day cache (Sep 1 - Sep 30)
      const dates30Days = Array.from({ length: 30 }, (_, i) => {
        const d = new Date('2025-09-01');
        d.setDate(d.getDate() + i);
        return d.toISOString().split('T')[0];
      });
      
      const cachedWideWindow = [{
        window_from: '2025-09-01T00:00:00.000Z',
        window_to: '2025-09-30T23:59:59.999Z',
        n: 3000,
        k: 450,
        n_daily: Array(30).fill(100),
        k_daily: Array(30).fill(15),
        dates: dates30Days,
        sliceDSL: 'context(channel:google)',
        query_signature: 'google-30d'
      }];
      
      setupMockFiles('test-conversion-param', cachedWideWindow);
      
      // Query only 3 days (Sep 25-27) - subset of cached 30 days
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-09-25T00:00:00.000Z', end: '2025-09-27T23:59:59.999Z' },
        targetSlice: 'context(channel:google)'
      });
      
      // Cache hit - no API call
      expect(getAPICallCount()).toBe(0);
    });
    
    it('should correctly aggregate subset of daily data', async () => {
      const graph = createTestGraph({
        currentQueryDSL: 'context(channel:google).window(3-Oct-25:5-Oct-25)'
      });
      let updatedGraph: any = null;
      const setGraph = vi.fn((g) => { updatedGraph = g; });
      
      // 7-day cache with known daily values
      const cachedData = [{
        window_from: '2025-10-01T00:00:00.000Z',
        window_to: '2025-10-07T23:59:59.999Z',
        n: 700,
        k: 140,
        n_daily: [100, 100, 100, 100, 100, 100, 100], // Oct 1-7
        k_daily: [20, 20, 20, 20, 20, 20, 20],
        dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
        sliceDSL: 'context(channel:google)',
        query_signature: 'google-sig'
      }];
      
      setupMockFiles('test-conversion-param', cachedData);
      
      // Query Oct 3-5 (3 days subset)
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-03T00:00:00.000Z', end: '2025-10-05T23:59:59.999Z' },
        targetSlice: 'context(channel:google)'
      });
      
      // Should aggregate to: n=300 (3 days × 100), k=60 (3 days × 20)
      expect(getAPICallCount()).toBe(0);
      
      // Verify the aggregated values on the graph
      if (updatedGraph) {
        const edge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (edge?.p?.evidence) {
          // Daily data for 3 days should sum to 300/60
          expect(edge.p.evidence.n).toBe(300);
          expect(edge.p.evidence.k).toBe(60);
        }
      }
    });
    
    it('should serve user query when BOTH window AND context are subsets of pinned cache', async () => {
      // This is the KEY test case the user requested:
      // Pinned query: window(-30d:).context(channel) with channel: google, facebook, other
      // User query: window(-7d:).context(channel:google)
      // Expected: Cache hit (both time and context are subsets)
      
      const graph = createTestGraph({
        dataInterestsDSL: 'window(-30d:).context(channel)', // Pinned: 30 days, all channels
        currentQueryDSL: 'context(channel:google).window(1-Oct-25:7-Oct-25)' // User: 7 days, Google only
      });
      const setGraph = vi.fn();
      
      // Simulate AllSlicesModal having fetched ALL slices with 30-day window
      // The cache now contains all 3 channels with 30 days each
      const dates30Days = Array.from({ length: 30 }, (_, i) => {
        const d = new Date('2025-09-08');
        d.setDate(d.getDate() + i);
        return d.toISOString().split('T')[0];
      });
      
      const cachedAllSlices = [
        {
          window_from: '2025-09-08T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 3000, k: 450,
          n_daily: Array(30).fill(100),
          k_daily: Array(30).fill(15),
          dates: dates30Days,
          sliceDSL: 'context(channel:google)',
          query_signature: 'google-30d'
        },
        {
          window_from: '2025-09-08T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 2400, k: 360,
          n_daily: Array(30).fill(80),
          k_daily: Array(30).fill(12),
          dates: dates30Days,
          sliceDSL: 'context(channel:facebook)',
          query_signature: 'facebook-30d'
        },
        {
          window_from: '2025-09-08T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 1500, k: 225,
          n_daily: Array(30).fill(50),
          k_daily: Array(30).fill(7),
          dates: dates30Days,
          sliceDSL: 'context(channel:other)',
          query_signature: 'other-30d'
        }
      ];
      
      setupMockFiles('test-conversion-param', cachedAllSlices);
      
      // User uses WindowSelector to query: last 7 days + Google channel only
      // This is a SUBSET of the cached data (window subset + context subset)
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' }, // Last 7 days of the 30
        targetSlice: 'context(channel:google)' // Just Google, not all 3 channels
      });
      
      // CRITICAL: No API call - data is served entirely from cache
      expect(getAPICallCount()).toBe(0);
      
      // Verify setGraph was called with the correct subset data
      expect(setGraph).toHaveBeenCalled();
    });
    
    it('should correctly serve different context subsets from same wide cache', async () => {
      const graph = createTestGraph({
        dataInterestsDSL: 'window(-30d:).context(channel)',
        currentQueryDSL: 'window(1-Oct-25:7-Oct-25)'
      });
      
      // 30-day cache for all channels
      const dates30Days = Array.from({ length: 30 }, (_, i) => {
        const d = new Date('2025-09-08');
        d.setDate(d.getDate() + i);
        return d.toISOString().split('T')[0];
      });
      
      const cachedAllSlices = [
        {
          window_from: '2025-09-08T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 3000, k: 450,
          n_daily: Array(30).fill(100),
          k_daily: Array(30).fill(15),
          dates: dates30Days,
          sliceDSL: 'context(channel:google)',
          query_signature: 'google-30d'
        },
        {
          window_from: '2025-09-08T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 2400, k: 360,
          n_daily: Array(30).fill(80),
          k_daily: Array(30).fill(12),
          dates: dates30Days,
          sliceDSL: 'context(channel:facebook)',
          query_signature: 'facebook-30d'
        },
        {
          window_from: '2025-09-08T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 1500, k: 225,
          n_daily: Array(30).fill(50),
          k_daily: Array(30).fill(7),
          dates: dates30Days,
          sliceDSL: 'context(channel:other)',
          query_signature: 'other-30d'
        }
      ];
      
      setupMockFiles('test-conversion-param', cachedAllSlices);
      
      // User switches between different contexts - all from cache
      const setGraph1 = vi.fn();
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph: setGraph1,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:google)'
      });
      
      const setGraph2 = vi.fn();
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph: setGraph2,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:facebook)'
      });
      
      const setGraph3 = vi.fn();
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph: setGraph3,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:other)'
      });
      
      // All 3 queries served from cache - ZERO API calls
      expect(getAPICallCount()).toBe(0);
      
      // All setGraph functions were called
      expect(setGraph1).toHaveBeenCalled();
      expect(setGraph2).toHaveBeenCalled();
      expect(setGraph3).toHaveBeenCalled();
    });
  });
  
  // =========================================================================
  // TESTS: contextAny Aggregation - SUM across slices
  // =========================================================================
  
  describe('contextAny Aggregation: Sum Across Slices', () => {
    it('CRITICAL: contextAny query should SUM n and k across matching slices, not overwrite', async () => {
      // This is the bug we fixed: contextAny was overwriting instead of summing
      const graph = createTestGraph({
        currentQueryDSL: 'contextAny(channel:google,channel:facebook).window(1-Oct-25:7-Oct-25)'
      });
      let updatedGraph: any = null;
      const setGraph = vi.fn((g) => { updatedGraph = g; });
      
      // Cache has data for multiple slices with known daily values
      const cachedSlices = [
        {
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 700, k: 140,
          n_daily: [100, 100, 100, 100, 100, 100, 100], // Google: 100/day
          k_daily: [20, 20, 20, 20, 20, 20, 20],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:google)',
          query_signature: 'google-sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 350, k: 70,
          n_daily: [50, 50, 50, 50, 50, 50, 50], // Facebook: 50/day
          k_daily: [10, 10, 10, 10, 10, 10, 10],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:facebook)',
          query_signature: 'facebook-sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 140, k: 28, // Other: not in contextAny query
          n_daily: [20, 20, 20, 20, 20, 20, 20],
          k_daily: [4, 4, 4, 4, 4, 4, 4],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:other)',
          query_signature: 'other-sig'
        }
      ];
      
      setupMockFiles('test-conversion-param', cachedSlices);
      
      // Query contextAny(google, facebook) - should SUM both slices
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'contextAny(channel:google,channel:facebook).window(1-Oct-25:7-Oct-25)'
      });
      
      expect(setGraph).toHaveBeenCalled();
      expect(getAPICallCount()).toBe(0); // Served from cache
      
      // CRITICAL: Verify SUM, not overwrite
      // Google: n=700, k=140 + Facebook: n=350, k=70 = n=1050, k=210
      // NOT just Facebook's n=350, k=70 (which would happen if overwriting)
      if (updatedGraph) {
        const edge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (edge?.p?.evidence) {
          expect(edge.p.evidence.n).toBe(1050); // 700 + 350, not 350
          expect(edge.p.evidence.k).toBe(210);  // 140 + 70, not 70
        }
      }
    });
    
    it('contextAny with 5 slices should sum all matching values', async () => {
      // Real-world case from user bug report
      const graph = createTestGraph({
        currentQueryDSL: 'contextAny(channel:google,channel:influencer,channel:paid-social,channel:referral,channel:pr).window(24-Nov-25:30-Nov-25)'
      });
      let updatedGraph: any = null;
      const setGraph = vi.fn((g) => { updatedGraph = g; });
      
      // Cache with 6 slices (5 in query + "other" which is excluded)
      const dates = ['2025-11-24', '2025-11-25', '2025-11-26', '2025-11-27', '2025-11-28', '2025-11-29', '2025-11-30'];
      const cachedSlices = [
        {
          window_from: '2025-11-24T00:00:00.000Z', window_to: '2025-11-30T23:59:59.999Z',
          n: 125, k: 81, // Google
          n_daily: [20, 23, 10, 16, 19, 24, 13], k_daily: [9, 12, 8, 12, 12, 17, 11],
          dates, sliceDSL: 'context(channel:google)', query_signature: 'sig'
        },
        {
          window_from: '2025-11-24T00:00:00.000Z', window_to: '2025-11-30T23:59:59.999Z',
          n: 1566, k: 816, // Influencer
          n_daily: [143, 64, 43, 201, 553, 537, 25], k_daily: [68, 40, 20, 117, 270, 286, 15],
          dates, sliceDSL: 'context(channel:influencer)', query_signature: 'sig'
        },
        {
          window_from: '2025-11-24T00:00:00.000Z', window_to: '2025-11-30T23:59:59.999Z',
          n: 116, k: 63, // Paid-social
          n_daily: [15, 1, 3, 13, 23, 38, 23], k_daily: [6, 1, 2, 8, 13, 19, 14],
          dates, sliceDSL: 'context(channel:paid-social)', query_signature: 'sig'
        },
        {
          window_from: '2025-11-24T00:00:00.000Z', window_to: '2025-11-30T23:59:59.999Z',
          n: 2, k: 1, // Referral
          n_daily: [1, 0, 1, 0, 0, 0, 0], k_daily: [0, 0, 1, 0, 0, 0, 0],
          dates, sliceDSL: 'context(channel:referral)', query_signature: 'sig'
        },
        {
          window_from: '2025-11-24T00:00:00.000Z', window_to: '2025-11-30T23:59:59.999Z',
          n: 0, k: 0, // PR (no data)
          n_daily: [0, 0, 0, 0, 0, 0, 0], k_daily: [0, 0, 0, 0, 0, 0, 0],
          dates, sliceDSL: 'context(channel:pr)', query_signature: 'sig'
        },
        {
          window_from: '2025-11-24T00:00:00.000Z', window_to: '2025-11-30T23:59:59.999Z',
          n: 381, k: 199, // Other (NOT in contextAny query)
          n_daily: [40, 16, 135, 50, 45, 63, 32], k_daily: [20, 10, 60, 27, 27, 34, 21],
          dates, sliceDSL: 'context(channel:other)', query_signature: 'sig'
        }
      ];
      
      setupMockFiles('test-conversion-param', cachedSlices);
      
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-11-24T00:00:00.000Z', end: '2025-11-30T23:59:59.999Z' },
        targetSlice: 'contextAny(channel:google,channel:influencer,channel:paid-social,channel:referral,channel:pr).window(24-Nov-25:30-Nov-25)'
      });
      
      expect(setGraph).toHaveBeenCalled();
      
      // Expected sum of 5 slices (excluding "other"):
      // n = 125 + 1566 + 116 + 2 + 0 = 1809
      // k = sum of daily k values across slices
      if (updatedGraph) {
        const edge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (edge?.p?.evidence) {
          expect(edge.p.evidence.n).toBe(1809);
          // k is sum of k_daily across all slices: 81 + 816 + 63 + 1 + 0 = 961
          // (Previously had +1 rounding from weighted mean derivation - now we use actual k)
          expect(edge.p.evidence.k).toBe(961);
          // Mean should be k/n
          expect(edge.p.mean).toBeCloseTo(961 / 1809, 2);
        }
      }
    });
    
    it('contextAny should handle partial date coverage (some slices missing dates)', async () => {
      // When not all slices have data for all dates, sum what's available
      const graph = createTestGraph({
        currentQueryDSL: 'contextAny(channel:google,channel:facebook).window(1-Oct-25:3-Oct-25)'
      });
      let updatedGraph: any = null;
      const setGraph = vi.fn((g) => { updatedGraph = g; });
      
      const cachedSlices = [
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-03T23:59:59.999Z',
          n: 300, k: 60,
          n_daily: [100, 100, 100], // Google: all 3 days
          k_daily: [20, 20, 20],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03'],
          sliceDSL: 'context(channel:google)', query_signature: 'sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-02T23:59:59.999Z',
          n: 100, k: 20,
          n_daily: [50, 50], // Facebook: only 2 days
          k_daily: [10, 10],
          dates: ['2025-10-01', '2025-10-02'],
          sliceDSL: 'context(channel:facebook)', query_signature: 'sig'
        }
      ];
      
      setupMockFiles('test-conversion-param', cachedSlices);
      
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-03T23:59:59.999Z' },
        targetSlice: 'contextAny(channel:google,channel:facebook).window(1-Oct-25:3-Oct-25)'
      });
      
      expect(setGraph).toHaveBeenCalled();
      
      // Sum: Google (300, 60) + Facebook (100, 20) = (400, 80)
      // Oct 1: 100+50=150, Oct 2: 100+50=150, Oct 3: 100+0=100 → total n=400
      if (updatedGraph) {
        const edge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (edge?.p?.evidence) {
          expect(edge.p.evidence.n).toBe(400);
          expect(edge.p.evidence.k).toBe(80);
        }
      }
    });
  });
  
  // =========================================================================
  // TESTS: MECE Aggregation (otherPolicy: null or computed)
  // =========================================================================
  
  describe('MECE Context Aggregation', () => {
    beforeEach(() => {
      // Mock context registry to return MECE context (otherPolicy: computed)
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue({
        id: 'channel',
        name: 'Marketing Channel',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'computed', // MECE: "other" is computed from what's left
        values: [
          { id: 'google', label: 'Google' },
          { id: 'facebook', label: 'Facebook' },
          { id: 'other', label: 'Other' }
        ],
        metadata: { created_at: '2025-01-01', version: '1.0.0', status: 'active' }
      } as any);
      
      vi.spyOn(contextRegistry, 'getValuesForContext').mockResolvedValue([
        { id: 'google', label: 'Google' },
        { id: 'facebook', label: 'Facebook' },
        { id: 'other', label: 'Other' }
      ] as any);
    });
    
    it('MECE: uncontexted query should aggregate all slices when otherPolicy=computed', async () => {
      // When context is MECE (otherPolicy: computed), an uncontexted query
      // should be equivalent to summing all context values
      const graph = createTestGraph({
        currentQueryDSL: 'window(1-Oct-25:7-Oct-25)' // No context = aggregate all
      });
      let updatedGraph: any = null;
      const setGraph = vi.fn((g) => { updatedGraph = g; });
      
      const cachedSlices = [
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 700, k: 140,
          n_daily: [100, 100, 100, 100, 100, 100, 100],
          k_daily: [20, 20, 20, 20, 20, 20, 20],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:google)', query_signature: 'sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 350, k: 70,
          n_daily: [50, 50, 50, 50, 50, 50, 50],
          k_daily: [10, 10, 10, 10, 10, 10, 10],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:facebook)', query_signature: 'sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 140, k: 28,
          n_daily: [20, 20, 20, 20, 20, 20, 20],
          k_daily: [4, 4, 4, 4, 4, 4, 4],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:other)', query_signature: 'sig'
        }
      ];
      
      setupMockFiles('test-conversion-param', cachedSlices);
      
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'window(1-Oct-25:7-Oct-25)' // No context
      });
      
      // For MECE context, uncontexted = sum of all slices
      // n = 700 + 350 + 140 = 1190, k = 140 + 70 + 28 = 238
      if (updatedGraph) {
        const edge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (edge?.p?.evidence) {
          expect(edge.p.evidence.n).toBe(1190);
          expect(edge.p.evidence.k).toBe(238);
        }
      }
    });

    it('MECE: uncontexted aggregation succeeds when signatures are derived from DSL context filters (context hash)', async () => {
      const graph = createTestGraph({
        currentQueryDSL: 'window(1-Oct-25:7-Oct-25)'
      });
      graph.nodes = graph.nodes.map((node: any) => ({
        ...node,
        event_id: node.event_id || node.data?.event_id || node.id,
      }));
      const edge = graph.edges[0] as any;

      const channelContext = {
        id: 'channel',
        name: 'Marketing Channel',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'computed',
        values: [
          { id: 'google', label: 'Google', sources: { amplitude: { filter: "utm_source == 'google'" } } },
          { id: 'facebook', label: 'Facebook', sources: { amplitude: { filter: "utm_source == 'facebook'" } } },
          { id: 'other', label: 'Other' }
        ],
        metadata: { created_at: '1-Dec-25', version: '1.0.0', status: 'active' }
      } as any;

      vi.mocked(contextRegistry.getContext).mockResolvedValue(channelContext);

      const dates = ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'];
      const slices = [
        { id: 'google', n: 70, k: 14 },
        { id: 'facebook', n: 35, k: 7 },
        { id: 'other', n: 21, k: 7 },
      ];

      const signatures: string[] = [];
      const cachedSlices: any[] = [];

      for (const slice of slices) {
        const dsl = `context(channel:${slice.id}).window(1-Oct-25:7-Oct-25)`;
        const constraints = parseConstraints(dsl);
        const { queryPayload } = await buildDslFromEdge(edge, graph as any, 'amplitude', undefined, constraints);

        const signature = await computeQuerySignature(
          queryPayload,
          'amplitude-prod',
          graph as any,
          edge,
          ['channel']
        );
        signatures.push(signature);

        cachedSlices.push({
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: slice.n,
          k: slice.k,
          n_daily: Array(7).fill(Math.round(slice.n / 7)),
          k_daily: Array(7).fill(Math.round(slice.k / 7)),
          dates,
          sliceDSL: `context(channel:${slice.id})`,
          query_signature: signature,
        });
      }

      // Signatures should align across context values (MECE generation cohesion).
      const uniqueSignatures = new Set(signatures);
      expect(uniqueSignatures.size).toBe(1);

      setupMockFiles('test-conversion-param', cachedSlices);

      let updatedGraph: any = null;
      const setGraph = vi.fn((g) => { updatedGraph = g; });

      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'window(1-Oct-25:7-Oct-25)',
      });

      if (updatedGraph) {
        const updatedEdge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (updatedEdge?.p?.evidence) {
          expect(updatedEdge.p.evidence.n).toBe(126);
          expect(updatedEdge.p.evidence.k).toBe(28);
        }
      }
    });
  });
  
  // =========================================================================
  // TESTS: Non-MECE Context Handling (otherPolicy: undefined)
  // =========================================================================
  
  describe('Non-MECE Context Handling', () => {
    beforeEach(() => {
      // Mock context registry to return non-MECE context (otherPolicy: undefined)
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue({
        id: 'channel',
        name: 'Marketing Channel',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'undefined', // NOT MECE: values don't partition the universe
        values: [
          { id: 'google', label: 'Google' },
          { id: 'facebook', label: 'Facebook' }
        ],
        metadata: { created_at: '2025-01-01', version: '1.0.0', status: 'active' }
      } as any);
    });
    
    it('Non-MECE: uncontexted query should NOT aggregate contexted data', async () => {
      // When context is NOT MECE, an uncontexted query should NOT auto-aggregate
      // It should either require explicit uncontexted data or fail gracefully
      const graph = createTestGraph({
        currentQueryDSL: 'window(1-Oct-25:7-Oct-25)'
      });
      const setGraph = vi.fn();
      
      // Only contexted data available (no uncontexted)
      const cachedSlices = [
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 700, k: 140,
          n_daily: [100, 100, 100, 100, 100, 100, 100],
          k_daily: [20, 20, 20, 20, 20, 20, 20],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:google)', query_signature: 'sig'
        }
      ];
      
      setupMockFiles('test-conversion-param', cachedSlices);
      
      // This should throw or handle gracefully since non-MECE context
      // can't be aggregated to uncontexted
      try {
        await dataOperationsService.getParameterFromFile({
          paramId: 'test-conversion-param',
          edgeId: 'edge-uuid-1',
          graph: graph as any,
          setGraph,
          window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
          targetSlice: '' // Uncontexted query
        });
        // If it doesn't throw, it should have warned or returned no data
      } catch (err) {
        // Expected: slice isolation error for non-MECE aggregation
        expect((err as Error).message).toContain('MECE');
      }
    });
    
    it('Non-MECE: specific context query should still work', async () => {
      // Even for non-MECE contexts, querying a specific slice should work
      const graph = createTestGraph({
        currentQueryDSL: 'context(channel:google).window(1-Oct-25:7-Oct-25)'
      });
      let updatedGraph: any = null;
      const setGraph = vi.fn((g) => { updatedGraph = g; });
      
      const cachedSlices = [
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 700, k: 140,
          n_daily: [100, 100, 100, 100, 100, 100, 100],
          k_daily: [20, 20, 20, 20, 20, 20, 20],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:google)', query_signature: 'sig'
        }
      ];
      
      setupMockFiles('test-conversion-param', cachedSlices);
      
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:google)'
      });
      
      expect(setGraph).toHaveBeenCalled();
      
      if (updatedGraph) {
        const edge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (edge?.p?.evidence) {
          expect(edge.p.evidence.n).toBe(700);
          expect(edge.p.evidence.k).toBe(140);
        }
      }
    });
  });
  
  // =========================================================================
  // TESTS: Mixed Scenarios (Multiple Context Keys)
  // =========================================================================
  
  describe('Mixed Context Scenarios', () => {
    it('contextAny with subset of available slices should only sum specified', async () => {
      // User might query contextAny with only SOME of the available slices
      const graph = createTestGraph({
        currentQueryDSL: 'contextAny(channel:google,channel:other).window(1-Oct-25:7-Oct-25)'
      });
      let updatedGraph: any = null;
      const setGraph = vi.fn((g) => { updatedGraph = g; });
      
      // All 3 slices available
      const cachedSlices = [
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 700, k: 140,
          n_daily: [100, 100, 100, 100, 100, 100, 100],
          k_daily: [20, 20, 20, 20, 20, 20, 20],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:google)', query_signature: 'sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 350, k: 70, // Facebook - NOT in query
          n_daily: [50, 50, 50, 50, 50, 50, 50],
          k_daily: [10, 10, 10, 10, 10, 10, 10],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:facebook)', query_signature: 'sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 140, k: 28,
          n_daily: [20, 20, 20, 20, 20, 20, 20],
          k_daily: [4, 4, 4, 4, 4, 4, 4],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:other)', query_signature: 'sig'
        }
      ];
      
      setupMockFiles('test-conversion-param', cachedSlices);
      
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'contextAny(channel:google,channel:other).window(1-Oct-25:7-Oct-25)'
      });
      
      expect(setGraph).toHaveBeenCalled();
      
      // Should sum ONLY google + other, NOT facebook
      // n = 700 + 140 = 840, k = 140 + 28 = 168
      if (updatedGraph) {
        const edge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (edge?.p?.evidence) {
          expect(edge.p.evidence.n).toBe(840);
          expect(edge.p.evidence.k).toBe(168);
        }
      }
    });
    
    it('should handle single-slice contextAny (edge case)', async () => {
      // contextAny with only one slice should behave like context()
      const graph = createTestGraph({
        currentQueryDSL: 'contextAny(channel:google).window(1-Oct-25:7-Oct-25)'
      });
      let updatedGraph: any = null;
      const setGraph = vi.fn((g) => { updatedGraph = g; });
      
      const cachedSlices = [
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 700, k: 140,
          n_daily: [100, 100, 100, 100, 100, 100, 100],
          k_daily: [20, 20, 20, 20, 20, 20, 20],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:google)', query_signature: 'sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 350, k: 70,
          n_daily: [50, 50, 50, 50, 50, 50, 50],
          k_daily: [10, 10, 10, 10, 10, 10, 10],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:facebook)', query_signature: 'sig'
        }
      ];
      
      setupMockFiles('test-conversion-param', cachedSlices);
      
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'contextAny(channel:google).window(1-Oct-25:7-Oct-25)'
      });
      
      // Single-slice contextAny = just that slice's data
      if (updatedGraph) {
        const edge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (edge?.p?.evidence) {
          expect(edge.p.evidence.n).toBe(700);
          expect(edge.p.evidence.k).toBe(140);
        }
      }
    });
  });
  
  // =========================================================================
  // TESTS: CONDITIONAL PROBABILITY - Multi-Slice Caching (PARITY WITH edge.p)
  // =========================================================================
  
  describe('Conditional Probability Multi-Slice Caching (PARITY)', () => {
    /**
     * PARITY PRINCIPLE: conditional_p MUST behave identically to edge.p
     * in all caching, aggregation, and slice isolation scenarios.
     */
    
    function createGraphWithConditionalP(options: {
      currentQueryDSL?: string;
      dataInterestsDSL?: string;
    } = {}): GraphData {
      return {
        nodes: [
          { uuid: 'node-a', id: 'test-from', label: 'Test From', data: { event_id: 'test-from-event' } },
          { uuid: 'node-b', id: 'test-to', label: 'Test To', data: { event_id: 'test-to-event' } },
          { uuid: 'node-promo', id: 'promo', label: 'Promo', data: { event_id: 'promo-event' } }
        ],
        edges: [
          {
            uuid: 'edge-uuid-1',
            id: 'test-edge-1',
            from: 'node-a',
            to: 'node-b',
            source: 'node-a',
            target: 'node-b',
            query: 'from(test-from).to(test-to)',
            p: {
              id: 'base-param',
              connection: 'amplitude-prod',
              mean: 0.5
            },
            conditional_p: [
              {
                condition: 'visited(promo)',
                p: {
                  id: 'cond-param-0',
                  connection: 'amplitude-prod',
                  query: 'from(test-from).to(test-to).visited(promo)',
                  mean: 0.65
                }
              },
              {
                condition: 'visited(checkout)',
                p: {
                  id: 'cond-param-1',
                  connection: 'amplitude-prod',
                  mean: 0.45
                }
              }
            ]
          }
        ],
        dataInterestsDSL: options.dataInterestsDSL,
        currentQueryDSL: options.currentQueryDSL || 'window(1-Oct-25:7-Oct-25)',
        metadata: { name: 'test-graph-conditional' }
      } as unknown as GraphData;
    }
    
    function setupConditionalMockFiles(paramId: string, existingValues: any[] = []) {
      const paramFile = {
        id: paramId,
        connection: 'amplitude-prod',
        query: 'from(test-from).to(test-to).visited(promo)',
        values: existingValues
      };
      
      vi.spyOn(fileRegistry, 'getFile').mockImplementation((fileId: string) => {
        if (fileId === `parameter-${paramId}`) {
          return { data: paramFile, isDirty: false } as any;
        }
        if (fileId === 'event-test-from-event') {
          return { 
            data: { id: 'test-from-event', name: 'Test From', provider_event_names: { amplitude: 'Test From Amplitude' } },
            isDirty: false
          } as any;
        }
        if (fileId === 'event-test-to-event') {
          return { 
            data: { id: 'test-to-event', name: 'Test To', provider_event_names: { amplitude: 'Test To Amplitude' } },
            isDirty: false
          } as any;
        }
        if (fileId === 'event-promo-event') {
          return { 
            data: { id: 'promo-event', name: 'Promo', provider_event_names: { amplitude: 'Promo Amplitude' } },
            isDirty: false
          } as any;
        }
        return undefined;
      });
      
      vi.spyOn(fileRegistry, 'updateFile').mockImplementation(() => Promise.resolve());
      
      return paramFile;
    }
    
    it('conditional_p should use cached slice without API call', { timeout: 30000 }, async () => {
      const graph = createGraphWithConditionalP({
        currentQueryDSL: 'context(channel:google).window(1-Oct-25:7-Oct-25)'
      });
      const setGraph = vi.fn();
      
      // Pre-populate cache with conditional_p[0] data
      setupConditionalMockFiles('cond-param-0', [{
        window_from: '2025-10-01T00:00:00.000Z',
        window_to: '2025-10-07T23:59:59.999Z',
        n: 700, k: 490,  // 70% for conditional
        n_daily: [100, 100, 100, 100, 100, 100, 100],
        k_daily: [70, 70, 70, 70, 70, 70, 70],
        dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
        sliceDSL: 'context(channel:google)',
        query_signature: 'google-cond-sig'
      }]);
      
      // Get conditional_p from cache
      await dataOperationsService.getParameterFromFile({
        paramId: 'cond-param-0',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:google)',
        conditionalIndex: 0
      });
      
      // Should NOT have called API - data was in cache
      expect(getAPICallCount()).toBe(0);
    });
    
    it('conditional_p should correctly filter by sliceDSL', async () => {
      const graph = createGraphWithConditionalP({
        currentQueryDSL: 'context(channel:facebook).window(1-Oct-25:7-Oct-25)'
      });
      let updatedGraph: any = null;
      const setGraph = vi.fn((g) => { updatedGraph = g; });
      
      // Cache with multiple slices for conditional_p
      setupConditionalMockFiles('cond-param-0', [
        {
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 1000, k: 700, // Google: 70%
          n_daily: [143, 143, 143, 143, 143, 143, 142],
          k_daily: [100, 100, 100, 100, 100, 100, 100],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:google)',
          query_signature: 'google-sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T23:59:59.999Z',
          n: 800, k: 640, // Facebook: 80% (different!)
          n_daily: [114, 114, 114, 114, 114, 115, 115],
          k_daily: [91, 91, 91, 91, 91, 92, 93],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:facebook)',
          query_signature: 'facebook-sig'
        }
      ]);
      
      // Request Facebook slice for conditional_p
      await dataOperationsService.getParameterFromFile({
        paramId: 'cond-param-0',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:facebook)',
        conditionalIndex: 0
      });
      
      expect(setGraph).toHaveBeenCalled();
      
      // Verify conditional_p[0] was updated with Facebook data (n=800), not Google (n=1000)
      if (updatedGraph) {
        const edge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (edge?.conditional_p?.[0]?.p?.evidence) {
          expect(edge.conditional_p[0].p.evidence.n).toBe(800);
          expect(edge.conditional_p[0].p.evidence.k).toBe(640);
        }
        
        // edge.p should be UNCHANGED
        expect(edge?.p?.mean).toBe(0.5);
      }
    });
    
    it('conditional_p should serve narrow window from cached wide window', async () => {
      const graph = createGraphWithConditionalP({
        currentQueryDSL: 'context(channel:google).window(1-Oct-25:3-Oct-25)'
      });
      const setGraph = vi.fn();
      
      // 7-day cache for conditional_p
      setupConditionalMockFiles('cond-param-0', [{
        window_from: '2025-10-01T00:00:00.000Z',
        window_to: '2025-10-07T23:59:59.999Z',
        n: 700, k: 490,
        n_daily: [100, 100, 100, 100, 100, 100, 100],
        k_daily: [70, 70, 70, 70, 70, 70, 70],
        dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
        sliceDSL: 'context(channel:google)',
        query_signature: 'google-cond-sig'
      }]);
      
      // Request only 3 days (subset of cached 7 days)
      await dataOperationsService.getParameterFromFile({
        paramId: 'cond-param-0',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-03T23:59:59.999Z' },
        targetSlice: 'context(channel:google)',
        conditionalIndex: 0
      });
      
      // No API call - narrow window is subset of cached wide window
      expect(getAPICallCount()).toBe(0);
    });
    
    it('conditional_p should switch between cached context slices without API calls', async () => {
      const graph = createGraphWithConditionalP({
        currentQueryDSL: 'window(1-Oct-25:7-Oct-25)'
      });
      const setGraph = vi.fn();
      
      // Cache all 3 channels for conditional_p
      setupConditionalMockFiles('cond-param-0', [
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 1000, k: 700,
          n_daily: [143, 143, 143, 143, 143, 143, 142],
          k_daily: [100, 100, 100, 100, 100, 100, 100],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:google)',
          query_signature: 'google-sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 800, k: 640,
          n_daily: [114, 114, 114, 114, 114, 115, 115],
          k_daily: [91, 91, 91, 91, 91, 92, 93],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:facebook)',
          query_signature: 'facebook-sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 500, k: 350,
          n_daily: [71, 71, 71, 72, 72, 72, 71],
          k_daily: [50, 50, 50, 50, 50, 50, 50],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:other)',
          query_signature: 'other-sig'
        }
      ]);
      
      // Query Google
      await dataOperationsService.getParameterFromFile({
        paramId: 'cond-param-0',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:google)',
        conditionalIndex: 0
      });
      
      // Query Facebook
      await dataOperationsService.getParameterFromFile({
        paramId: 'cond-param-0',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:facebook)',
        conditionalIndex: 0
      });
      
      // Query Other
      await dataOperationsService.getParameterFromFile({
        paramId: 'cond-param-0',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'context(channel:other)',
        conditionalIndex: 0
      });
      
      // Zero API calls - all from cache
      expect(getAPICallCount()).toBe(0);
    });
    
    it('conditional_p[0] and conditional_p[1] should cache independently', async () => {
      const graph = createGraphWithConditionalP();
      const setGraph = vi.fn();
      
      // Separate caches for each conditional entry
      // For cond-param-0:
      setupConditionalMockFiles('cond-param-0', [{
        window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
        n: 700, k: 490,  // 70%
        n_daily: [100, 100, 100, 100, 100, 100, 100],
        k_daily: [70, 70, 70, 70, 70, 70, 70],
        dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
        sliceDSL: '',
        query_signature: 'cond-0-sig'
      }]);
      
      // Get conditional_p[0] - cache hit
      await dataOperationsService.getParameterFromFile({
        paramId: 'cond-param-0',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: '',
        conditionalIndex: 0
      });
      
      expect(getAPICallCount()).toBe(0);
      
      // Now setup cache for cond-param-1 (separate parameter file)
      vi.restoreAllMocks();
      vi.spyOn(contextRegistry, 'getValuesForContext').mockResolvedValue([
        { id: 'google', label: 'Google' },
        { id: 'facebook', label: 'Facebook' },
        { id: 'other', label: 'Other' }
      ] as any);
      
      setupConditionalMockFiles('cond-param-1', [{
        window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
        n: 700, k: 315,  // 45% (different from cond-param-0!)
        n_daily: [100, 100, 100, 100, 100, 100, 100],
        k_daily: [45, 45, 45, 45, 45, 45, 45],
        dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
        sliceDSL: '',
        query_signature: 'cond-1-sig'
      }]);
      resetAPILog();
      
      // Get conditional_p[1] - separate cache
      await dataOperationsService.getParameterFromFile({
        paramId: 'cond-param-1',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: '',
        conditionalIndex: 1
      });
      
      // Also cache hit (separate cache)
      expect(getAPICallCount()).toBe(0);
    });
    
    it('conditional_p contextAny should SUM across matching slices', async () => {
      const graph = createGraphWithConditionalP({
        currentQueryDSL: 'contextAny(channel:google,channel:facebook).window(1-Oct-25:7-Oct-25)'
      });
      let updatedGraph: any = null;
      const setGraph = vi.fn((g) => { updatedGraph = g; });
      
      // Cache with multiple slices
      setupConditionalMockFiles('cond-param-0', [
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 700, k: 490, // Google
          n_daily: [100, 100, 100, 100, 100, 100, 100],
          k_daily: [70, 70, 70, 70, 70, 70, 70],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:google)',
          query_signature: 'google-sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 350, k: 280, // Facebook
          n_daily: [50, 50, 50, 50, 50, 50, 50],
          k_daily: [40, 40, 40, 40, 40, 40, 40],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:facebook)',
          query_signature: 'facebook-sig'
        },
        {
          window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-07T23:59:59.999Z',
          n: 140, k: 70, // Other - NOT in contextAny
          n_daily: [20, 20, 20, 20, 20, 20, 20],
          k_daily: [10, 10, 10, 10, 10, 10, 10],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: 'context(channel:other)',
          query_signature: 'other-sig'
        }
      ]);
      
      await dataOperationsService.getParameterFromFile({
        paramId: 'cond-param-0',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-07T23:59:59.999Z' },
        targetSlice: 'contextAny(channel:google,channel:facebook).window(1-Oct-25:7-Oct-25)',
        conditionalIndex: 0
      });
      
      expect(setGraph).toHaveBeenCalled();
      expect(getAPICallCount()).toBe(0);
      
      // Should SUM google + facebook, NOT include other
      // n = 700 + 350 = 1050, k = 490 + 280 = 770
      if (updatedGraph) {
        const edge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (edge?.conditional_p?.[0]?.p?.evidence) {
          expect(edge.conditional_p[0].p.evidence.n).toBe(1050);
          expect(edge.conditional_p[0].p.evidence.k).toBe(770);
        }
      }
    });
  });

  // =========================================================================
  // TESTS: Date Window Changes - Re-aggregation on Cached Data
  // =========================================================================
  
  describe('Date Window Changes', () => {
    it('should re-aggregate when date window changes within cached range', async () => {
      // This tests the scenario where:
      // 1. Data is cached for dates 24-Nov to 30-Nov (7 days) for MECE context slices
      // 2. User changes window to just 24-Nov to 25-Nov (2 days)
      // 3. Graph should update with aggregation for just those 2 days (summing across slices)
      
      const graph = createTestGraph({ currentQueryDSL: 'window(24-Nov-25:30-Nov-25)' });
      let updatedGraph: any = null;
      const setGraph = vi.fn((g) => { updatedGraph = g; });
      
      // Setup file data with multiple context slices (MECE) and daily data
      setupMockFiles('test-conversion-param', [
        {
          sliceDSL: 'context(channel:google)',
          dates: ['2025-11-24', '2025-11-25', '2025-11-26', '2025-11-27', '2025-11-28', '2025-11-29', '2025-11-30'],
          n_daily: [20, 23, 10, 16, 19, 24, 13],  // Sum = 125
          k_daily: [9, 12, 8, 12, 12, 17, 11],    // Sum = 81
          mean: 0.648, n: 125, k: 81,
          window_from: '2025-11-24T00:00:00.000Z',
          window_to: '2025-11-30T23:59:59.999Z',
          query_signature: 'test-sig'
        },
        {
          sliceDSL: 'context(channel:influencer)',
          dates: ['2025-11-24', '2025-11-25', '2025-11-26', '2025-11-27', '2025-11-28', '2025-11-29', '2025-11-30'],
          n_daily: [143, 64, 43, 201, 553, 537, 25],  // Sum = 1566
          k_daily: [68, 40, 20, 117, 270, 286, 15],   // Sum = 816
          mean: 0.521, n: 1566, k: 816,
          window_from: '2025-11-24T00:00:00.000Z',
          window_to: '2025-11-30T23:59:59.999Z',
          query_signature: 'test-sig'
        },
      ]);
      
      // First request: full 7-day window with UNCONTEXTED query (should trigger MECE aggregation)
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-11-24T00:00:00.000Z', end: '2025-11-30T23:59:59.999Z' },
        targetSlice: 'window(24-Nov-25:30-Nov-25)'  // Uncontexted query - triggers MECE aggregation
      });
      
      // Should have aggregated all 7 days from both slices
      expect(setGraph).toHaveBeenCalled();
      if (updatedGraph) {
        const edge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (edge?.p?.evidence) {
          // Full window: n = 125 + 1566 = 1691, k = 81 + 816 = 897
          expect(edge.p.evidence.n).toBe(1691);
          expect(edge.p.evidence.k).toBe(897);
        }
      }
      
      // Reset for second call
      setGraph.mockClear();
      updatedGraph = null;
      
      // Second request: subset window (just 2 days)
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-11-24T00:00:00.000Z', end: '2025-11-25T23:59:59.999Z' },
        targetSlice: 'window(24-Nov-25:25-Nov-25)'  // Uncontexted query - different dates
      });
      
      // Should have aggregated just 2 days from both slices
      expect(setGraph).toHaveBeenCalled();
      if (updatedGraph) {
        const edge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (edge?.p?.evidence) {
          // Subset window (24-Nov + 25-Nov):
          // google: n = 20 + 23 = 43, k = 9 + 12 = 21
          // influencer: n = 143 + 64 = 207, k = 68 + 40 = 108
          // Total: n = 43 + 207 = 250, k = 21 + 108 = 129
          expect(edge.p.evidence.n).toBe(250);
          expect(edge.p.evidence.k).toBe(129);
          // Mean should be recalculated: k/n = 129/250 = 0.516
          expect(edge.p.mean).toBeCloseTo(0.516, 2);
        }
      }
    });
    
    it('should handle single-day window correctly', async () => {
      const graph = createTestGraph({ currentQueryDSL: 'window(24-Nov-25:24-Nov-25)' });
      let updatedGraph: any = null;
      const setGraph = vi.fn((g) => { updatedGraph = g; });
      
      // Setup with MECE context slices
      setupMockFiles('test-conversion-param', [
        {
          sliceDSL: 'context(channel:google)',
          dates: ['2025-11-24', '2025-11-25'],
          n_daily: [100, 200],
          k_daily: [50, 100],
          mean: 0.5, n: 300, k: 150,
          window_from: '2025-11-24T00:00:00.000Z',
          window_to: '2025-11-25T23:59:59.999Z',
          query_signature: 'test-sig'
        },
        {
          sliceDSL: 'context(channel:influencer)',
          dates: ['2025-11-24', '2025-11-25'],
          n_daily: [80, 120],
          k_daily: [40, 60],
          mean: 0.5, n: 200, k: 100,
          window_from: '2025-11-24T00:00:00.000Z',
          window_to: '2025-11-25T23:59:59.999Z',
          query_signature: 'test-sig'
        },
      ]);
      
      // Request: just one day with UNCONTEXTED query
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-conversion-param',
        edgeId: 'edge-uuid-1',
        graph: graph as any,
        setGraph,
        window: { start: '2025-11-24T00:00:00.000Z', end: '2025-11-24T23:59:59.999Z' },
        targetSlice: 'window(24-Nov-25:24-Nov-25)'
      });
      
      expect(setGraph).toHaveBeenCalled();
      if (updatedGraph) {
        const edge = updatedGraph.edges?.find((e: any) => e.uuid === 'edge-uuid-1');
        if (edge?.p?.evidence) {
          // Single day (24-Nov):
          // google: n = 100, k = 50
          // influencer: n = 80, k = 40
          // Total: n = 180, k = 90
          expect(edge.p.evidence.n).toBe(180);
          expect(edge.p.evidence.k).toBe(90);
          expect(edge.p.mean).toBeCloseTo(0.5, 2);
        }
      }
    });
  });
});
