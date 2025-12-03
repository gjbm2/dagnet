/**
 * End-to-End Tests: Versioned Fetch Flow with IDB
 * 
 * Full integration tests that:
 * 1. Mock the Amplitude API response
 * 2. Use real IDB (via fake-indexeddb) for parameter file storage
 * 3. Verify data flows correctly: API → IDB → Graph
 * 4. Test multiple scenarios (fresh fetch, incremental, bust cache, etc.)
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

// Types
interface ParameterValue {
  window_from: string;
  window_to: string;
  n: number;
  k: number;
  n_daily?: number[];
  k_daily?: number[];
  dates?: string[];
  sliceDSL?: string;
  query_signature?: string;
}

interface ParameterFile {
  id: string;
  connection: string;
  query: string;
  values: ParameterValue[];
}

interface ConditionalProbabilityEntry {
  condition: string;
  p: {
    id?: string;
    connection?: string;
    query?: string;
    mean?: number;
    stdev?: number;
    evidence?: {
      n: number;
      k: number;
      window_from?: string;
      window_to?: string;
    };
  };
}

interface GraphEdge {
  uuid: string;
  id: string;
  from: string;
  to: string;
  query: string;
  p: {
    id?: string;
    connection?: string;
    mean?: number;
    stdev?: number;
    evidence?: {
      n: number;
      k: number;
      window_from?: string;
      window_to?: string;
    };
  };
  conditional_p?: ConditionalProbabilityEntry[];
}

interface Graph {
  nodes: any[];
  edges: GraphEdge[];
  currentQueryDSL?: string;
  metadata?: any;
}

// ============================================================================
// MOCK IDB IMPLEMENTATION
// ============================================================================

class MockIDB {
  private db: IDBDatabase | null = null;
  private dbName = 'dagnet-test';
  private storeName = 'files';
  
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'id' });
        }
      };
    });
  }
  
  async putFile(id: string, data: any): Promise<void> {
    if (!this.db) throw new Error('DB not initialized');
    
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.put({ id, data, updatedAt: new Date().toISOString() });
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
  
  async getFile(id: string): Promise<any | null> {
    if (!this.db) throw new Error('DB not initialized');
    
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.get(id);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }
  
  async clear(): Promise<void> {
    if (!this.db) return;
    
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.clear();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
  
  close(): void {
    this.db?.close();
    this.db = null;
  }
}

// ============================================================================
// MOCK AMPLITUDE API
// ============================================================================

interface AmplitudeResponse {
  data: Array<{
    formattedXValues: string[];
    stepByStepSeries: number[][];
    series: number[][];
  }>;
}

class MockAmplitudeAPI {
  private responses: Map<string, AmplitudeResponse> = new Map();
  public callLog: Array<{ url: string; start: string; end: string }> = [];
  
  /**
   * Set up a mock response for a specific date range
   */
  setResponse(start: string, end: string, data: { dates: string[]; n: number[]; k: number[] }): void {
    const key = `${start}|${end}`;
    this.responses.set(key, {
      data: [{
        formattedXValues: data.dates,
        stepByStepSeries: [data.n, data.k],
        series: [data.n, data.k]
      }]
    });
  }
  
  /**
   * Get response for a request (simulates API call)
   */
  async fetch(url: string): Promise<AmplitudeResponse> {
    // Parse date range from URL
    const startMatch = url.match(/start=(\d{8})/);
    const endMatch = url.match(/end=(\d{8})/);
    
    const start = startMatch?.[1] || '';
    const end = endMatch?.[1] || '';
    
    this.callLog.push({ url, start, end });
    
    const key = `${start}|${end}`;
    const response = this.responses.get(key);
    
    if (response) {
      return response;
    }
    
    // Default response for any date range
    return {
      data: [{
        formattedXValues: [this.formatDate(start)],
        stepByStepSeries: [[100], [50]],
        series: [[100], [50]]
      }]
    };
  }
  
  private formatDate(yyyymmdd: string): string {
    if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd;
    return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  }
  
  reset(): void {
    this.responses.clear();
    this.callLog = [];
  }
}

// ============================================================================
// VERSIONED FETCH SERVICE (Simplified for Testing)
// ============================================================================

class VersionedFetchService {
  constructor(
    private idb: MockIDB,
    private api: MockAmplitudeAPI
  ) {}
  
  /**
   * Main entry point: Fetch from source (versioned)
   * 
   * Flow: WindowSelector → getFromSource → getFromSourceDirect → IDB → Graph
   */
  async getFromSource(options: {
    paramId: string;
    edgeId: string;
    graph: Graph;
    currentDSL: string; // From WindowSelector (e.g., "window(1-Oct-25:1-Oct-25)")
    bustCache?: boolean;
  }): Promise<Graph> {
    const { paramId, edgeId, graph, currentDSL, bustCache = false } = options;
    
    // 1. Parse window from DSL
    const windowMatch = currentDSL.match(/window\(([^:]*):([^)]*)\)/);
    if (!windowMatch) {
      throw new Error(`Invalid DSL - no window found: ${currentDSL}`);
    }
    
    const windowStart = this.parseUKDate(windowMatch[1]);
    const windowEnd = this.parseUKDate(windowMatch[2]);
    
    // 2. Get existing parameter file from IDB
    const paramFileRecord = await this.idb.getFile(`parameter-${paramId}`);
    let paramFile: ParameterFile = paramFileRecord?.data || {
      id: paramId,
      connection: 'amplitude-prod',
      query: graph.edges.find(e => e.uuid === edgeId)?.query || '',
      values: []
    };
    
    // 3. Check if we need to fetch (incremental check)
    const needsFetch = bustCache || !this.hasDataForWindow(paramFile, windowStart, windowEnd);
    
    if (needsFetch) {
      // 4. Fetch from API
      const apiData = await this.fetchFromAPI(windowStart, windowEnd);
      
      // 5. Merge into parameter file
      paramFile = this.mergeTimeSeriesData(paramFile, apiData, windowStart, windowEnd);
      
      // 6. Write to IDB
      await this.idb.putFile(`parameter-${paramId}`, paramFile);
    }
    
    // 7. Apply to graph using the PASSED currentDSL (not graph.currentQueryDSL!)
    // This is the critical part - we use currentDSL, not graph.currentQueryDSL
    const updatedGraph = this.applyToGraph(graph, edgeId, paramFile, windowStart, windowEnd, currentDSL);
    
    return updatedGraph;
  }
  
  /**
   * Parse d-MMM-yy date to Date object (UTC)
   */
  private parseUKDate(dateStr: string): Date {
    const parts = dateStr.split('-');
    if (parts.length !== 3) throw new Error(`Invalid date: ${dateStr}`);
    
    const day = parseInt(parts[0], 10);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months.indexOf(parts[1]);
    const yearShort = parseInt(parts[2], 10);
    const year = yearShort < 50 ? 2000 + yearShort : 1900 + yearShort;
    
    // CRITICAL: Use Date.UTC to avoid timezone issues
    return new Date(Date.UTC(year, month, day));
  }
  
  /**
   * Check if parameter file has data for the requested window
   */
  private hasDataForWindow(paramFile: ParameterFile, start: Date, end: Date): boolean {
    for (const value of paramFile.values) {
      const valueStart = new Date(value.window_from);
      const valueEnd = new Date(value.window_to);
      
      // Check if this value covers the requested window
      if (valueStart <= start && valueEnd >= end) {
        return true;
      }
    }
    return false;
  }
  
  /**
   * Fetch data from API
   */
  private async fetchFromAPI(start: Date, end: Date): Promise<{ dates: string[]; n: number[]; k: number[] }> {
    const startStr = this.formatAPIDate(start);
    const endStr = this.formatAPIDate(end);
    
    const url = `https://amplitude.com/api/2/funnels?start=${startStr}&end=${endStr}`;
    const response = await this.api.fetch(url);
    
    const data = response.data[0];
    return {
      dates: data.formattedXValues,
      n: data.stepByStepSeries[0],
      k: data.stepByStepSeries[1]
    };
  }
  
  private formatAPIDate(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }
  
  /**
   * Merge new time-series data into parameter file
   * Replaces existing data for the same window
   */
  private mergeTimeSeriesData(
    paramFile: ParameterFile,
    data: { dates: string[]; n: number[]; k: number[] },
    start: Date,
    end: Date
  ): ParameterFile {
    const totalN = data.n.reduce((a, b) => a + b, 0);
    const totalK = data.k.reduce((a, b) => a + b, 0);
    
    const newValue: ParameterValue = {
      window_from: start.toISOString(),
      window_to: end.toISOString(),
      n: totalN,
      k: totalK,
      n_daily: data.n,
      k_daily: data.k,
      dates: data.dates,
      sliceDSL: ''
    };
    
    // Remove existing values for the same window, then add new one
    const filteredValues = paramFile.values.filter(v => {
      const vStart = new Date(v.window_from).getTime();
      const vEnd = new Date(v.window_to).getTime();
      const reqStart = start.getTime();
      const reqEnd = end.getTime();
      // Keep if windows don't overlap
      return !(vStart === reqStart && vEnd === reqEnd);
    });
    
    return {
      ...paramFile,
      values: [...filteredValues, newValue]
    };
  }
  
  /**
   * Apply parameter file data to graph
   * 
   * CRITICAL: Uses the passed currentDSL for window selection, NOT graph.currentQueryDSL
   */
  private applyToGraph(
    graph: Graph,
    edgeId: string,
    paramFile: ParameterFile,
    windowStart: Date,
    windowEnd: Date,
    currentDSL: string // MUST use this, not graph.currentQueryDSL!
  ): Graph {
    const edge = graph.edges.find(e => e.uuid === edgeId);
    if (!edge) return graph;
    
    // Find data that matches the requested window
    // IMPORTANT: Filter by the passed window, not graph.currentQueryDSL
    // Get the LAST matching value (most recent in case of bust cache)
    let matchingValue: ParameterValue | undefined;
    
    for (const value of paramFile.values) {
      const valueStart = new Date(value.window_from);
      const valueEnd = new Date(value.window_to);
      
      // Check for overlap - prefer later entries (most recent data)
      if (valueStart <= windowEnd && valueEnd >= windowStart) {
        matchingValue = value; // Keep iterating to get last match
      }
    }
    
    if (!matchingValue) {
      console.warn('[applyToGraph] No matching data for window:', { windowStart, windowEnd });
      return graph;
    }
    
    // Aggregate within the requested window
    let aggregatedN = 0;
    let aggregatedK = 0;
    
    if (matchingValue.n_daily && matchingValue.k_daily && matchingValue.dates) {
      for (let i = 0; i < matchingValue.dates.length; i++) {
        const dateStr = matchingValue.dates[i];
        const date = new Date(dateStr);
        
        if (date >= windowStart && date <= windowEnd) {
          aggregatedN += matchingValue.n_daily[i];
          aggregatedK += matchingValue.k_daily[i];
        }
      }
    } else {
      aggregatedN = matchingValue.n;
      aggregatedK = matchingValue.k;
    }
    
    // Update edge
    const updatedEdge: GraphEdge = {
      ...edge,
      p: {
        ...edge.p,
        mean: aggregatedN > 0 ? aggregatedK / aggregatedN : 0,
        evidence: {
          n: aggregatedN,
          k: aggregatedK,
          window_from: windowStart.toISOString(),
          window_to: windowEnd.toISOString()
        }
      }
    };
    
    return {
      ...graph,
      edges: graph.edges.map(e => e.uuid === edgeId ? updatedEdge : e)
    };
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe('Versioned Fetch Flow E2E', () => {
  let idb: MockIDB;
  let api: MockAmplitudeAPI;
  let service: VersionedFetchService;
  
  beforeAll(async () => {
    // Reset IndexedDB
    indexedDB = new IDBFactory();
  });
  
  beforeEach(async () => {
    idb = new MockIDB();
    await idb.init();
    
    api = new MockAmplitudeAPI();
    service = new VersionedFetchService(idb, api);
  });
  
  afterEach(async () => {
    await idb.clear();
    idb.close();
    api.reset();
  });
  
  // -------------------------------------------------------------------------
  // Helper to create test graph
  // -------------------------------------------------------------------------
  
  function createGraph(options: { currentQueryDSL?: string } = {}): Graph {
    return {
      nodes: [
        { uuid: 'node-a', id: 'from-node', event_id: 'event-a' },
        { uuid: 'node-b', id: 'to-node', event_id: 'event-b' }
      ],
      edges: [{
        uuid: 'edge-1',
        id: 'edge-1',
        from: 'node-a',
        to: 'node-b',
        query: 'from(from-node).to(to-node)',
        p: {
          id: 'test-param',
          connection: 'amplitude-prod',
          mean: 0.5
        }
      }],
      currentQueryDSL: options.currentQueryDSL || 'window(28-Oct-25:14-Nov-25)', // STALE
      metadata: { name: 'test' }
    };
  }
  
  // -------------------------------------------------------------------------
  // Scenario 1: Fresh fetch (no existing data)
  // -------------------------------------------------------------------------
  
  describe('Scenario: Fresh fetch (no existing data in IDB)', () => {
    it('should fetch from API and store in IDB', async () => {
      const graph = createGraph();
      
      // Set up API response for Oct 1st
      api.setResponse('20251001', '20251001', {
        dates: ['2025-10-01'],
        n: [100],
        k: [50]
      });
      
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)'
      });
      
      // Should have called API
      expect(api.callLog).toHaveLength(1);
      expect(api.callLog[0].start).toBe('20251001');
      expect(api.callLog[0].end).toBe('20251001');
      
      // Should have stored in IDB
      const storedFile = await idb.getFile('parameter-test-param');
      expect(storedFile).not.toBeNull();
      expect(storedFile.data.values).toHaveLength(1);
      
      // Graph should be updated with correct values
      const edge = result.edges.find(e => e.uuid === 'edge-1');
      expect(edge?.p.evidence?.n).toBe(100);
      expect(edge?.p.evidence?.k).toBe(50);
      expect(edge?.p.mean).toBe(0.5); // 50/100
    });
  });
  
  // -------------------------------------------------------------------------
  // Scenario 2: Incremental fetch (some data exists)
  // -------------------------------------------------------------------------
  
  describe('Scenario: Incremental fetch (data already exists for window)', () => {
    it('should NOT call API if data exists for requested window', async () => {
      const graph = createGraph();
      
      // Pre-populate IDB with Oct 1st data
      await idb.putFile('parameter-test-param', {
        id: 'test-param',
        connection: 'amplitude-prod',
        query: 'from(from-node).to(to-node)',
        values: [{
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-01T00:00:00.000Z',
          n: 200,
          k: 100,
          n_daily: [200],
          k_daily: [100],
          dates: ['2025-10-01'],
          sliceDSL: ''
        }]
      });
      
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)'
      });
      
      // Should NOT have called API (data exists)
      expect(api.callLog).toHaveLength(0);
      
      // Should use existing data from IDB
      const edge = result.edges.find(e => e.uuid === 'edge-1');
      expect(edge?.p.evidence?.n).toBe(200);
      expect(edge?.p.evidence?.k).toBe(100);
    });
    
    it('should call API if data does NOT exist for requested window', async () => {
      const graph = createGraph();
      
      // Pre-populate IDB with Oct 28th data (DIFFERENT window)
      await idb.putFile('parameter-test-param', {
        id: 'test-param',
        connection: 'amplitude-prod',
        query: 'from(from-node).to(to-node)',
        values: [{
          window_from: '2025-10-28T00:00:00.000Z',
          window_to: '2025-11-14T00:00:00.000Z',
          n: 500,
          k: 250,
          sliceDSL: ''
        }]
      });
      
      // Set up API response for Oct 1st
      api.setResponse('20251001', '20251001', {
        dates: ['2025-10-01'],
        n: [100],
        k: [50]
      });
      
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)' // Request Oct 1st
      });
      
      // SHOULD have called API (no data for Oct 1st)
      expect(api.callLog).toHaveLength(1);
      expect(api.callLog[0].start).toBe('20251001');
      
      // IDB should now have BOTH entries
      const storedFile = await idb.getFile('parameter-test-param');
      expect(storedFile.data.values).toHaveLength(2);
      
      // Graph should have Oct 1st data
      const edge = result.edges.find(e => e.uuid === 'edge-1');
      expect(edge?.p.evidence?.n).toBe(100);
    });
  });
  
  // -------------------------------------------------------------------------
  // Scenario 3: Bust cache
  // -------------------------------------------------------------------------
  
  describe('Scenario: Bust cache (force re-fetch)', () => {
    it('should call API even if data exists when bustCache=true', async () => {
      const graph = createGraph();
      
      // Pre-populate IDB with Oct 1st data
      await idb.putFile('parameter-test-param', {
        id: 'test-param',
        connection: 'amplitude-prod',
        query: 'from(from-node).to(to-node)',
        values: [{
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-01T00:00:00.000Z',
          n: 200,
          k: 100,
          sliceDSL: ''
        }]
      });
      
      // Set up API response with DIFFERENT data
      api.setResponse('20251001', '20251001', {
        dates: ['2025-10-01'],
        n: [300], // Different from cached
        k: [150]
      });
      
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)',
        bustCache: true // Force re-fetch!
      });
      
      // SHOULD have called API despite data existing
      expect(api.callLog).toHaveLength(1);
      
      // Should have NEW data from API
      const edge = result.edges.find(e => e.uuid === 'edge-1');
      expect(edge?.p.evidence?.n).toBe(300);
      expect(edge?.p.evidence?.k).toBe(150);
    });
  });
  
  // -------------------------------------------------------------------------
  // Scenario 4: currentDSL vs graph.currentQueryDSL (THE CRITICAL BUG)
  // -------------------------------------------------------------------------
  
  describe('Scenario: currentDSL should override graph.currentQueryDSL', () => {
    it('should use passed currentDSL, NOT stale graph.currentQueryDSL', async () => {
      // Graph has STALE currentQueryDSL
      const graph = createGraph({
        currentQueryDSL: 'window(28-Oct-25:14-Nov-25)' // STALE - should be IGNORED
      });
      
      // IDB has data for BOTH windows
      await idb.putFile('parameter-test-param', {
        id: 'test-param',
        connection: 'amplitude-prod',
        query: 'from(from-node).to(to-node)',
        values: [
          // Oct 1st data
          {
            window_from: '2025-10-01T00:00:00.000Z',
            window_to: '2025-10-01T00:00:00.000Z',
            n: 100,
            k: 50,
            n_daily: [100],
            k_daily: [50],
            dates: ['2025-10-01'],
            sliceDSL: ''
          },
          // Oct 28 - Nov 14 data
          {
            window_from: '2025-10-28T00:00:00.000Z',
            window_to: '2025-11-14T00:00:00.000Z',
            n: 500,
            k: 250,
            n_daily: [500],
            k_daily: [250],
            dates: ['2025-10-28'],
            sliceDSL: ''
          }
        ]
      });
      
      // Request Oct 1st via currentDSL (passed from WindowSelector)
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)' // THIS should be used
      });
      
      // Should get Oct 1st data (n=100), NOT Oct 28th data (n=500)
      const edge = result.edges.find(e => e.uuid === 'edge-1');
      expect(edge?.p.evidence?.n).toBe(100);
      expect(edge?.p.evidence?.k).toBe(50);
      
      // Mean should be 50/100 = 0.5
      expect(edge?.p.mean).toBe(0.5);
    });
    
    it('should aggregate only dates within the requested window', async () => {
      const graph = createGraph();
      
      // IDB has multi-day data
      await idb.putFile('parameter-test-param', {
        id: 'test-param',
        connection: 'amplitude-prod',
        query: 'from(from-node).to(to-node)',
        values: [{
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-05T00:00:00.000Z',
          n: 500, // Total
          k: 250,
          n_daily: [100, 100, 100, 100, 100], // 5 days
          k_daily: [50, 50, 50, 50, 50],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05'],
          sliceDSL: ''
        }]
      });
      
      // Request ONLY Oct 1st
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)'
      });
      
      // Should get ONLY Oct 1st data (n=100), not all 5 days (n=500)
      const edge = result.edges.find(e => e.uuid === 'edge-1');
      expect(edge?.p.evidence?.n).toBe(100);
      expect(edge?.p.evidence?.k).toBe(50);
    });
  });
  
  // -------------------------------------------------------------------------
  // Scenario 5: Timezone handling
  // -------------------------------------------------------------------------
  
  describe('Scenario: Timezone handling (UTC dates)', () => {
    it('should parse 1-Oct-25 as 2025-10-01 UTC, not shifted by timezone', async () => {
      const graph = createGraph();
      
      // Set up API response
      api.setResponse('20251001', '20251001', {
        dates: ['2025-10-01'],
        n: [100],
        k: [50]
      });
      
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)'
      });
      
      // API should be called with October 1st
      expect(api.callLog[0].start).toBe('20251001');
      expect(api.callLog[0].end).toBe('20251001');
      
      // Should NOT be September 30th (which would indicate timezone bug)
      expect(api.callLog[0].start).not.toBe('20250930');
    });
  });
  
  // -------------------------------------------------------------------------
  // Scenario 6: Error handling
  // -------------------------------------------------------------------------
  
  describe('Scenario: Error handling', () => {
    it('should throw on invalid DSL format', async () => {
      const graph = createGraph();
      
      // Missing colon in window
      await expect(
        service.getFromSource({
          paramId: 'test-param',
          edgeId: 'edge-1',
          graph,
          currentDSL: 'window(1-Oct-25,1-Oct-25)' // WRONG: comma instead of colon
        })
      ).rejects.toThrow('Invalid DSL');
    });
  });
  
  // -------------------------------------------------------------------------
  // Scenario 7: Multiple sequential fetches
  // -------------------------------------------------------------------------
  
  describe('Scenario: Multiple sequential fetches', () => {
    it('should accumulate data in IDB across fetches', async () => {
      const graph = createGraph();
      
      // First fetch: Oct 1st
      api.setResponse('20251001', '20251001', {
        dates: ['2025-10-01'],
        n: [100],
        k: [50]
      });
      
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)'
      });
      
      // Second fetch: Oct 15th
      api.setResponse('20251015', '20251015', {
        dates: ['2025-10-15'],
        n: [200],
        k: [100]
      });
      
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(15-Oct-25:15-Oct-25)'
      });
      
      // IDB should have both entries
      const storedFile = await idb.getFile('parameter-test-param');
      expect(storedFile.data.values).toHaveLength(2);
      
      // Both dates should be represented
      const windows = storedFile.data.values.map((v: ParameterValue) => v.window_from);
      expect(windows).toContain('2025-10-01T00:00:00.000Z');
      expect(windows).toContain('2025-10-15T00:00:00.000Z');
    });
  });
});

// ============================================================================
// CONDITIONAL PROBABILITY E2E TESTS (PARITY WITH edge.p)
// ============================================================================

describe('Versioned Fetch Flow E2E - Conditional Probability', () => {
  /**
   * PARITY PRINCIPLE: conditional_p MUST behave identically to edge.p
   * in all file management, data operations, and scenarios.
   * 
   * These tests mirror the edge.p tests above to ensure parity.
   */
  
  let idb: MockIDB;
  let api: MockAmplitudeAPI;
  let service: VersionedFetchService;
  
  beforeAll(async () => {
    indexedDB = new IDBFactory();
  });
  
  beforeEach(async () => {
    idb = new MockIDB();
    await idb.init();
    
    api = new MockAmplitudeAPI();
    service = new VersionedFetchService(idb, api);
  });
  
  afterEach(async () => {
    await idb.clear();
    idb.close();
    api.reset();
  });
  
  // -------------------------------------------------------------------------
  // Helper to create test graph with conditional_p
  // -------------------------------------------------------------------------
  
  function createGraphWithConditionalP(options: { currentQueryDSL?: string } = {}): Graph {
    return {
      nodes: [
        { uuid: 'node-a', id: 'from-node', event_id: 'event-a' },
        { uuid: 'node-b', id: 'to-node', event_id: 'event-b' },
        { uuid: 'node-promo', id: 'promo', event_id: 'promo-event' }
      ],
      edges: [{
        uuid: 'edge-1',
        id: 'edge-1',
        from: 'node-a',
        to: 'node-b',
        query: 'from(from-node).to(to-node)',
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
              query: 'from(from-node).to(to-node).visited(promo)',
              mean: 0.65
            }
          },
          {
            condition: 'visited(checkout)',
            p: {
              id: 'cond-param-1',
              connection: 'amplitude-prod',
              query: 'from(from-node).to(to-node).visited(checkout)',
              mean: 0.45
            }
          }
        ]
      }],
      currentQueryDSL: options.currentQueryDSL || 'window(28-Oct-25:14-Nov-25)', // STALE
      metadata: { name: 'test-conditional' }
    };
  }

  // Extended service with conditional_p support
  class ConditionalVersionedFetchService extends VersionedFetchService {
    async getFromSourceConditional(options: {
      paramId: string;
      edgeId: string;
      graph: Graph;
      currentDSL: string;
      conditionalIndex: number;
      bustCache?: boolean;
    }): Promise<Graph> {
      const { paramId, edgeId, graph, currentDSL, conditionalIndex, bustCache = false } = options;
      
      // 1. Parse window from DSL
      const windowMatch = currentDSL.match(/window\(([^:]*):([^)]*)\)/);
      if (!windowMatch) {
        throw new Error(`Invalid DSL - no window found: ${currentDSL}`);
      }
      
      const windowStart = this.parseUKDatePublic(windowMatch[1]);
      const windowEnd = this.parseUKDatePublic(windowMatch[2]);
      
      // 2. Get existing parameter file from IDB
      const paramFileRecord = await this._idbRef.getFile(`parameter-${paramId}`);
      const edge = graph.edges.find(e => e.uuid === edgeId);
      const conditionalEntry = edge?.conditional_p?.[conditionalIndex];
      
      let paramFile: ParameterFile = paramFileRecord?.data || {
        id: paramId,
        connection: 'amplitude-prod',
        query: conditionalEntry?.p?.query || '',
        values: []
      };
      
      // 3. Check if we need to fetch (incremental check)
      const needsFetch = bustCache || !this.hasDataForWindowPublic(paramFile, windowStart, windowEnd);
      
      if (needsFetch) {
        // 4. Fetch from API
        const apiData = await this.fetchFromAPIPublic(windowStart, windowEnd);
        
        // 5. Merge into parameter file
        paramFile = this.mergeTimeSeriesDataPublic(paramFile, apiData, windowStart, windowEnd);
        
        // 6. Write to IDB
        await this._idbRef.putFile(`parameter-${paramId}`, paramFile);
      }
      
      // 7. Apply to conditional_p (not edge.p!)
      const updatedGraph = this.applyToConditionalP(
        graph, 
        edgeId, 
        paramFile, 
        windowStart, 
        windowEnd, 
        conditionalIndex
      );
      
      return updatedGraph;
    }
    
    // Expose private methods for testing
    parseUKDatePublic(dateStr: string): Date {
      const parts = dateStr.split('-');
      if (parts.length !== 3) throw new Error(`Invalid date: ${dateStr}`);
      
      const day = parseInt(parts[0], 10);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const month = months.indexOf(parts[1]);
      const yearShort = parseInt(parts[2], 10);
      const year = yearShort < 50 ? 2000 + yearShort : 1900 + yearShort;
      
      return new Date(Date.UTC(year, month, day));
    }
    
    hasDataForWindowPublic(paramFile: ParameterFile, start: Date, end: Date): boolean {
      for (const value of paramFile.values) {
        const valueStart = new Date(value.window_from);
        const valueEnd = new Date(value.window_to);
        if (valueStart <= start && valueEnd >= end) {
          return true;
        }
      }
      return false;
    }
    
    async fetchFromAPIPublic(start: Date, end: Date): Promise<{ dates: string[]; n: number[]; k: number[] }> {
      const startStr = this.formatAPIDatePublic(start);
      const endStr = this.formatAPIDatePublic(end);
      
      const url = `https://amplitude.com/api/2/funnels?start=${startStr}&end=${endStr}`;
      const response = await this._apiRef.fetch(url);
      
      const data = response.data[0];
      return {
        dates: data.formattedXValues,
        n: data.stepByStepSeries[0],
        k: data.stepByStepSeries[1]
      };
    }
    
    formatAPIDatePublic(date: Date): string {
      const y = date.getUTCFullYear();
      const m = String(date.getUTCMonth() + 1).padStart(2, '0');
      const d = String(date.getUTCDate()).padStart(2, '0');
      return `${y}${m}${d}`;
    }
    
    mergeTimeSeriesDataPublic(
      paramFile: ParameterFile,
      data: { dates: string[]; n: number[]; k: number[] },
      start: Date,
      end: Date
    ): ParameterFile {
      const totalN = data.n.reduce((a, b) => a + b, 0);
      const totalK = data.k.reduce((a, b) => a + b, 0);
      
      const newValue: ParameterValue = {
        window_from: start.toISOString(),
        window_to: end.toISOString(),
        n: totalN,
        k: totalK,
        n_daily: data.n,
        k_daily: data.k,
        dates: data.dates,
        sliceDSL: ''
      };
      
      const filteredValues = paramFile.values.filter(v => {
        const vStart = new Date(v.window_from).getTime();
        const vEnd = new Date(v.window_to).getTime();
        const reqStart = start.getTime();
        const reqEnd = end.getTime();
        return !(vStart === reqStart && vEnd === reqEnd);
      });
      
      return {
        ...paramFile,
        values: [...filteredValues, newValue]
      };
    }
    
    /**
     * Apply parameter file data to conditional_p[index]
     * 
     * CRITICAL: Updates conditional_p[conditionalIndex].p, NOT edge.p
     */
    applyToConditionalP(
      graph: Graph,
      edgeId: string,
      paramFile: ParameterFile,
      windowStart: Date,
      windowEnd: Date,
      conditionalIndex: number
    ): Graph {
      const edge = graph.edges.find(e => e.uuid === edgeId);
      if (!edge || !edge.conditional_p?.[conditionalIndex]) return graph;
      
      // Find data that matches the requested window
      let matchingValue: ParameterValue | undefined;
      
      for (const value of paramFile.values) {
        const valueStart = new Date(value.window_from);
        const valueEnd = new Date(value.window_to);
        
        if (valueStart <= windowEnd && valueEnd >= windowStart) {
          matchingValue = value;
        }
      }
      
      if (!matchingValue) {
        return graph;
      }
      
      // Aggregate within the requested window
      let aggregatedN = 0;
      let aggregatedK = 0;
      
      if (matchingValue.n_daily && matchingValue.k_daily && matchingValue.dates) {
        for (let i = 0; i < matchingValue.dates.length; i++) {
          const dateStr = matchingValue.dates[i];
          const date = new Date(dateStr);
          
          if (date >= windowStart && date <= windowEnd) {
            aggregatedN += matchingValue.n_daily[i];
            aggregatedK += matchingValue.k_daily[i];
          }
        }
      } else {
        aggregatedN = matchingValue.n;
        aggregatedK = matchingValue.k;
      }
      
      // Update conditional_p[index].p (NOT edge.p!)
      const updatedConditionalP = [...(edge.conditional_p || [])];
      updatedConditionalP[conditionalIndex] = {
        ...updatedConditionalP[conditionalIndex],
        p: {
          ...updatedConditionalP[conditionalIndex].p,
          mean: aggregatedN > 0 ? aggregatedK / aggregatedN : 0,
          evidence: {
            n: aggregatedN,
            k: aggregatedK,
            window_from: windowStart.toISOString(),
            window_to: windowEnd.toISOString()
          }
        }
      };
      
      return {
        ...graph,
        edges: graph.edges.map(e => 
          e.uuid === edgeId 
            ? { ...e, conditional_p: updatedConditionalP }
            : e
        )
      };
    }
    
    // Store refs to idb/api for subclass use
    private _idbRef: MockIDB;
    private _apiRef: MockAmplitudeAPI;
    
    constructor(idb: MockIDB, api: MockAmplitudeAPI) {
      super(idb, api);
      this._idbRef = idb;
      this._apiRef = api;
    }
    
    // Expose for internal use
    protected get idbRef(): MockIDB { return this._idbRef; }
    protected get apiRef(): MockAmplitudeAPI { return this._apiRef; }
  }
  
  // -------------------------------------------------------------------------
  // Scenario 1: Fresh fetch for conditional_p
  // -------------------------------------------------------------------------
  
  describe('Scenario: Fresh fetch for conditional_p (no existing data in IDB)', () => {
    it('should fetch from API and store in IDB for conditional_p[0]', async () => {
      const condService = new ConditionalVersionedFetchService(idb, api);
      const graph = createGraphWithConditionalP();
      
      // Set up API response for Oct 1st
      api.setResponse('20251001', '20251001', {
        dates: ['2025-10-01'],
        n: [100],
        k: [70]  // 70% conversion for conditional
      });
      
      const result = await condService.getFromSourceConditional({
        paramId: 'cond-param-0',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)',
        conditionalIndex: 0
      });
      
      // Should have called API
      expect(api.callLog).toHaveLength(1);
      expect(api.callLog[0].start).toBe('20251001');
      
      // Should have stored in IDB
      const storedFile = await idb.getFile('parameter-cond-param-0');
      expect(storedFile).not.toBeNull();
      expect(storedFile.data.values).toHaveLength(1);
      
      // conditional_p[0] should be updated
      const edge = result.edges.find(e => e.uuid === 'edge-1');
      expect(edge?.conditional_p?.[0].p.evidence?.n).toBe(100);
      expect(edge?.conditional_p?.[0].p.evidence?.k).toBe(70);
      expect(edge?.conditional_p?.[0].p.mean).toBe(0.7); // 70/100
      
      // edge.p should be UNCHANGED
      expect(edge?.p.mean).toBe(0.5);
    });
    
    it('should fetch for conditional_p[1] independently', async () => {
      const condService = new ConditionalVersionedFetchService(idb, api);
      const graph = createGraphWithConditionalP();
      
      // Set up API response
      api.setResponse('20251001', '20251001', {
        dates: ['2025-10-01'],
        n: [200],
        k: [90]  // 45% conversion for conditional[1]
      });
      
      const result = await condService.getFromSourceConditional({
        paramId: 'cond-param-1',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)',
        conditionalIndex: 1  // Second conditional entry
      });
      
      // conditional_p[1] should be updated
      const edge = result.edges.find(e => e.uuid === 'edge-1');
      expect(edge?.conditional_p?.[1].p.evidence?.n).toBe(200);
      expect(edge?.conditional_p?.[1].p.evidence?.k).toBe(90);
      expect(edge?.conditional_p?.[1].p.mean).toBe(0.45);
      
      // conditional_p[0] should be UNCHANGED
      expect(edge?.conditional_p?.[0].p.mean).toBe(0.65);
    });
  });
  
  // -------------------------------------------------------------------------
  // Scenario 2: Incremental fetch for conditional_p
  // -------------------------------------------------------------------------
  
  describe('Scenario: Incremental fetch for conditional_p', () => {
    it('should NOT call API if data exists for requested window', async () => {
      const condService = new ConditionalVersionedFetchService(idb, api);
      const graph = createGraphWithConditionalP();
      
      // Pre-populate IDB with Oct 1st data
      await idb.putFile('parameter-cond-param-0', {
        id: 'cond-param-0',
        connection: 'amplitude-prod',
        query: 'from(from-node).to(to-node).visited(promo)',
        values: [{
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-01T00:00:00.000Z',
          n: 200,
          k: 140,
          n_daily: [200],
          k_daily: [140],
          dates: ['2025-10-01'],
          sliceDSL: ''
        }]
      });
      
      const result = await condService.getFromSourceConditional({
        paramId: 'cond-param-0',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)',
        conditionalIndex: 0
      });
      
      // Should NOT have called API (data exists)
      expect(api.callLog).toHaveLength(0);
      
      // Should use existing data from IDB
      const edge = result.edges.find(e => e.uuid === 'edge-1');
      expect(edge?.conditional_p?.[0].p.evidence?.n).toBe(200);
      expect(edge?.conditional_p?.[0].p.evidence?.k).toBe(140);
    });
  });
  
  // -------------------------------------------------------------------------
  // Scenario 3: Bust cache for conditional_p
  // -------------------------------------------------------------------------
  
  describe('Scenario: Bust cache for conditional_p', () => {
    it('should call API even if data exists when bustCache=true', async () => {
      const condService = new ConditionalVersionedFetchService(idb, api);
      const graph = createGraphWithConditionalP();
      
      // Pre-populate IDB with Oct 1st data
      await idb.putFile('parameter-cond-param-0', {
        id: 'cond-param-0',
        connection: 'amplitude-prod',
        query: 'from(from-node).to(to-node).visited(promo)',
        values: [{
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-01T00:00:00.000Z',
          n: 200,
          k: 140,
          sliceDSL: ''
        }]
      });
      
      // Set up API response with DIFFERENT data
      api.setResponse('20251001', '20251001', {
        dates: ['2025-10-01'],
        n: [300],
        k: [240]  // Different from cached
      });
      
      const result = await condService.getFromSourceConditional({
        paramId: 'cond-param-0',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)',
        conditionalIndex: 0,
        bustCache: true
      });
      
      // SHOULD have called API despite data existing
      expect(api.callLog).toHaveLength(1);
      
      // Should have NEW data from API
      const edge = result.edges.find(e => e.uuid === 'edge-1');
      expect(edge?.conditional_p?.[0].p.evidence?.n).toBe(300);
      expect(edge?.conditional_p?.[0].p.evidence?.k).toBe(240);
    });
  });
  
  // -------------------------------------------------------------------------
  // Scenario 4: currentDSL vs graph.currentQueryDSL for conditional_p
  // -------------------------------------------------------------------------
  
  describe('Scenario: currentDSL should override graph.currentQueryDSL for conditional_p', () => {
    it('should use passed currentDSL, NOT stale graph.currentQueryDSL', async () => {
      const condService = new ConditionalVersionedFetchService(idb, api);
      
      // Graph has STALE currentQueryDSL
      const graph = createGraphWithConditionalP({
        currentQueryDSL: 'window(28-Oct-25:14-Nov-25)' // STALE
      });
      
      // IDB has data for BOTH windows
      await idb.putFile('parameter-cond-param-0', {
        id: 'cond-param-0',
        connection: 'amplitude-prod',
        query: 'from(from-node).to(to-node).visited(promo)',
        values: [
          // Oct 1st data
          {
            window_from: '2025-10-01T00:00:00.000Z',
            window_to: '2025-10-01T00:00:00.000Z',
            n: 100,
            k: 70,
            n_daily: [100],
            k_daily: [70],
            dates: ['2025-10-01'],
            sliceDSL: ''
          },
          // Oct 28 - Nov 14 data
          {
            window_from: '2025-10-28T00:00:00.000Z',
            window_to: '2025-11-14T00:00:00.000Z',
            n: 500,
            k: 400,
            n_daily: [500],
            k_daily: [400],
            dates: ['2025-10-28'],
            sliceDSL: ''
          }
        ]
      });
      
      // Request Oct 1st via currentDSL
      const result = await condService.getFromSourceConditional({
        paramId: 'cond-param-0',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)', // THIS should be used
        conditionalIndex: 0
      });
      
      // Should get Oct 1st data (n=100), NOT Oct 28th data (n=500)
      const edge = result.edges.find(e => e.uuid === 'edge-1');
      expect(edge?.conditional_p?.[0].p.evidence?.n).toBe(100);
      expect(edge?.conditional_p?.[0].p.evidence?.k).toBe(70);
      expect(edge?.conditional_p?.[0].p.mean).toBe(0.7);
    });
  });
  
  // -------------------------------------------------------------------------
  // Scenario 5: Independent updates to edge.p and conditional_p
  // -------------------------------------------------------------------------
  
  describe('Scenario: Independent updates to edge.p and conditional_p', () => {
    it('updating conditional_p should NOT affect edge.p', async () => {
      const condService = new ConditionalVersionedFetchService(idb, api);
      const graph = createGraphWithConditionalP();
      
      api.setResponse('20251001', '20251001', {
        dates: ['2025-10-01'],
        n: [100],
        k: [80]
      });
      
      const result = await condService.getFromSourceConditional({
        paramId: 'cond-param-0',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)',
        conditionalIndex: 0
      });
      
      const edge = result.edges.find(e => e.uuid === 'edge-1');
      
      // conditional_p[0] should be updated
      expect(edge?.conditional_p?.[0].p.mean).toBe(0.8);
      
      // edge.p should be UNCHANGED
      expect(edge?.p.mean).toBe(0.5);
      
      // conditional_p[1] should be UNCHANGED
      expect(edge?.conditional_p?.[1].p.mean).toBe(0.45);
    });
    
    it('updating edge.p should NOT affect conditional_p', async () => {
      const graph = createGraphWithConditionalP();
      
      api.setResponse('20251001', '20251001', {
        dates: ['2025-10-01'],
        n: [100],
        k: [30]
      });
      
      // Update edge.p (using base service)
      const result = await service.getFromSource({
        paramId: 'base-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)'
      });
      
      const edge = result.edges.find(e => e.uuid === 'edge-1');
      
      // edge.p should be updated
      expect(edge?.p.mean).toBe(0.3);
      
      // conditional_p should be UNCHANGED
      expect(edge?.conditional_p?.[0].p.mean).toBe(0.65);
      expect(edge?.conditional_p?.[1].p.mean).toBe(0.45);
    });
  });
  
  // -------------------------------------------------------------------------
  // Scenario 6: Condition preservation
  // -------------------------------------------------------------------------
  
  describe('Scenario: Condition string preservation', () => {
    it('should preserve condition string after update', async () => {
      const condService = new ConditionalVersionedFetchService(idb, api);
      const graph = createGraphWithConditionalP();
      
      api.setResponse('20251001', '20251001', {
        dates: ['2025-10-01'],
        n: [100],
        k: [70]
      });
      
      const result = await condService.getFromSourceConditional({
        paramId: 'cond-param-0',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)',
        conditionalIndex: 0
      });
      
      const edge = result.edges.find(e => e.uuid === 'edge-1');
      
      // Condition strings should be preserved
      expect(edge?.conditional_p?.[0].condition).toBe('visited(promo)');
      expect(edge?.conditional_p?.[1].condition).toBe('visited(checkout)');
    });
  });
});

