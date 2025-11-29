/**
 * Comprehensive Parameter Cache E2E Tests
 * 
 * Tests REAL caching behavior with:
 * - Actual IDB storage (fake-indexeddb)
 * - Multiple date ranges and query signatures
 * - Incremental fetch optimization
 * - Cache hit/miss scenarios
 * - Complex real-world patterns
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

// ============================================================================
// TYPES
// ============================================================================

interface TimeSeriesPoint {
  date: string;
  n: number;
  k: number;
}

interface ParameterValue {
  window_from: string;
  window_to: string;
  n: number;
  k: number;
  n_daily: number[];
  k_daily: number[];
  dates: string[];
  sliceDSL: string;
  query_signature?: string;
  retrieved_at?: string;
}

interface ParameterFile {
  id: string;
  connection: string;
  query: string;
  values: ParameterValue[];
}

interface Graph {
  nodes: any[];
  edges: any[];
  currentQueryDSL?: string;
}

interface APICallRecord {
  start: string;
  end: string;
  timestamp: Date;
  response: TimeSeriesPoint[];
}

// ============================================================================
// MOCK IDB
// ============================================================================

class TestIDB {
  private db: IDBDatabase | null = null;
  private dbName = 'dagnet-cache-test';
  
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
        if (!db.objectStoreNames.contains('parameters')) {
          db.createObjectStore('parameters', { keyPath: 'id' });
        }
      };
    });
  }
  
  async putParameter(id: string, data: ParameterFile): Promise<void> {
    if (!this.db) throw new Error('DB not initialized');
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('parameters', 'readwrite');
      const store = tx.objectStore('parameters');
      store.put({ ...data, id });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  
  async getParameter(id: string): Promise<ParameterFile | null> {
    if (!this.db) throw new Error('DB not initialized');
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('parameters', 'readonly');
      const store = tx.objectStore('parameters');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
  
  async clear(): Promise<void> {
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('parameters', 'readwrite');
      const store = tx.objectStore('parameters');
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
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

class MockAmplitudeAPI {
  public callLog: APICallRecord[] = [];
  private responseOverrides: Map<string, TimeSeriesPoint[]> = new Map();
  
  /**
   * Set custom response for a specific date range
   */
  setResponseForRange(start: string, end: string, data: TimeSeriesPoint[]): void {
    this.responseOverrides.set(`${start}|${end}`, data);
  }
  
  /**
   * Generate daily data for a date range
   */
  private generateDailyData(start: Date, end: Date): TimeSeriesPoint[] {
    const data: TimeSeriesPoint[] = [];
    const current = new Date(start);
    
    while (current <= end) {
      const dateStr = current.toISOString().split('T')[0];
      // Generate realistic-looking data: n between 50-200, k is 30-70% of n
      const n = 50 + Math.floor(Math.random() * 150);
      const k = Math.floor(n * (0.3 + Math.random() * 0.4));
      data.push({ date: dateStr, n, k });
      current.setUTCDate(current.getUTCDate() + 1);
    }
    
    return data;
  }
  
  /**
   * Simulate API call
   */
  async fetch(startDate: Date, endDate: Date): Promise<TimeSeriesPoint[]> {
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];
    
    // Check for override
    const key = `${startStr}|${endStr}`;
    let response: TimeSeriesPoint[];
    
    if (this.responseOverrides.has(key)) {
      response = this.responseOverrides.get(key)!;
    } else {
      response = this.generateDailyData(startDate, endDate);
    }
    
    this.callLog.push({
      start: startStr,
      end: endStr,
      timestamp: new Date(),
      response
    });
    
    return response;
  }
  
  reset(): void {
    this.callLog = [];
    this.responseOverrides.clear();
  }
  
  getCallCount(): number {
    return this.callLog.length;
  }
  
  wasDateRangeFetched(start: string, end: string): boolean {
    return this.callLog.some(call => call.start === start && call.end === end);
  }
}

// ============================================================================
// VERSIONED FETCH SERVICE (Cache-aware)
// ============================================================================

class CacheAwareVersionedFetchService {
  constructor(
    private idb: TestIDB,
    private api: MockAmplitudeAPI
  ) {}
  
  /**
   * Main fetch method with cache checking
   */
  async getFromSource(options: {
    paramId: string;
    edgeId: string;
    graph: Graph;
    currentDSL: string;
    bustCache?: boolean;
    querySignature?: string;
  }): Promise<{ graph: Graph; fromCache: boolean; fetchedDays: number }> {
    const { paramId, edgeId, graph, currentDSL, bustCache = false, querySignature = 'default-sig' } = options;
    
    // 1. Parse window from DSL
    const { start: windowStart, end: windowEnd } = this.parseWindow(currentDSL);
    
    // 2. Get existing parameter file
    let paramFile = await this.idb.getParameter(paramId);
    if (!paramFile) {
      paramFile = {
        id: paramId,
        connection: 'amplitude-prod',
        query: graph.edges.find(e => e.uuid === edgeId)?.query || '',
        values: []
      };
    }
    
    // 3. Determine what dates need to be fetched
    const { needsFetch, datesToFetch, fromCache } = this.checkCache(
      paramFile,
      windowStart,
      windowEnd,
      querySignature,
      bustCache
    );
    
    let fetchedDays = 0;
    
    if (needsFetch && datesToFetch.length > 0) {
      // 4. Fetch missing dates from API
      const fetchedData = await this.fetchMissingDates(datesToFetch);
      fetchedDays = fetchedData.length;
      
      // 5. Merge into parameter file
      paramFile = this.mergeData(paramFile, fetchedData, windowStart, windowEnd, querySignature);
      
      // 6. Write back to IDB
      await this.idb.putParameter(paramId, paramFile);
    }
    
    // 7. Apply to graph
    const updatedGraph = this.applyToGraph(graph, edgeId, paramFile, windowStart, windowEnd, querySignature);
    
    return {
      graph: updatedGraph,
      fromCache: !needsFetch,
      fetchedDays
    };
  }
  
  private parseWindow(dsl: string): { start: Date; end: Date } {
    const match = dsl.match(/window\(([^:]*):([^)]*)\)/);
    if (!match) throw new Error(`Invalid DSL: ${dsl}`);
    
    return {
      start: this.parseUKDate(match[1]),
      end: this.parseUKDate(match[2])
    };
  }
  
  private parseUKDate(dateStr: string): Date {
    const parts = dateStr.split('-');
    if (parts.length !== 3) throw new Error(`Invalid date: ${dateStr}`);
    
    const day = parseInt(parts[0], 10);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months.indexOf(parts[1]);
    const yearShort = parseInt(parts[2], 10);
    const year = yearShort < 50 ? 2000 + yearShort : 1900 + yearShort;
    
    return new Date(Date.UTC(year, month, day));
  }
  
  /**
   * Check cache coverage and determine what needs fetching
   */
  private checkCache(
    paramFile: ParameterFile,
    start: Date,
    end: Date,
    querySignature: string,
    bustCache: boolean
  ): { needsFetch: boolean; datesToFetch: Date[]; fromCache: boolean } {
    if (bustCache) {
      // Bust cache - fetch all dates in range
      return {
        needsFetch: true,
        datesToFetch: this.generateDateRange(start, end),
        fromCache: false
      };
    }
    
    // Find existing data with matching query signature
    const matchingValues = paramFile.values.filter(v => 
      v.query_signature === querySignature || !v.query_signature
    );
    
    // Get all cached dates
    const cachedDates = new Set<string>();
    for (const value of matchingValues) {
      if (value.dates) {
        value.dates.forEach(d => cachedDates.add(d));
      }
    }
    
    // Find missing dates
    const requestedDates = this.generateDateRange(start, end);
    const missingDates = requestedDates.filter(d => 
      !cachedDates.has(d.toISOString().split('T')[0])
    );
    
    if (missingDates.length === 0) {
      return { needsFetch: false, datesToFetch: [], fromCache: true };
    }
    
    return {
      needsFetch: true,
      datesToFetch: missingDates,
      fromCache: false
    };
  }
  
  private generateDateRange(start: Date, end: Date): Date[] {
    const dates: Date[] = [];
    const current = new Date(start);
    
    while (current <= end) {
      dates.push(new Date(current));
      current.setUTCDate(current.getUTCDate() + 1);
    }
    
    return dates;
  }
  
  private async fetchMissingDates(dates: Date[]): Promise<TimeSeriesPoint[]> {
    if (dates.length === 0) return [];
    
    // Group consecutive dates into ranges for efficient API calls
    const ranges = this.groupConsecutiveDates(dates);
    const allData: TimeSeriesPoint[] = [];
    
    for (const range of ranges) {
      const data = await this.api.fetch(range.start, range.end);
      allData.push(...data);
    }
    
    return allData;
  }
  
  private groupConsecutiveDates(dates: Date[]): Array<{ start: Date; end: Date }> {
    if (dates.length === 0) return [];
    
    const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
    const ranges: Array<{ start: Date; end: Date }> = [];
    
    let rangeStart = sorted[0];
    let rangeEnd = sorted[0];
    
    for (let i = 1; i < sorted.length; i++) {
      const diff = sorted[i].getTime() - rangeEnd.getTime();
      const oneDay = 24 * 60 * 60 * 1000;
      
      if (diff === oneDay) {
        rangeEnd = sorted[i];
      } else {
        ranges.push({ start: rangeStart, end: rangeEnd });
        rangeStart = sorted[i];
        rangeEnd = sorted[i];
      }
    }
    
    ranges.push({ start: rangeStart, end: rangeEnd });
    return ranges;
  }
  
  private mergeData(
    paramFile: ParameterFile,
    newData: TimeSeriesPoint[],
    windowStart: Date,
    windowEnd: Date,
    querySignature: string
  ): ParameterFile {
    const totalN = newData.reduce((sum, p) => sum + p.n, 0);
    const totalK = newData.reduce((sum, p) => sum + p.k, 0);
    
    const newValue: ParameterValue = {
      window_from: windowStart.toISOString(),
      window_to: windowEnd.toISOString(),
      n: totalN,
      k: totalK,
      n_daily: newData.map(p => p.n),
      k_daily: newData.map(p => p.k),
      dates: newData.map(p => p.date),
      sliceDSL: '',
      query_signature: querySignature,
      retrieved_at: new Date().toISOString()
    };
    
    // Remove existing entries that overlap with new data dates
    const newDates = new Set(newData.map(p => p.date));
    const filteredValues = paramFile.values.map(v => {
      if (!v.dates || !v.n_daily || !v.k_daily) return v;
      if (v.query_signature && v.query_signature !== querySignature) return v;
      
      // Filter out dates that are being replaced
      const filteredIndices = v.dates
        .map((d, i) => newDates.has(d) ? -1 : i)
        .filter(i => i !== -1);
      
      if (filteredIndices.length === 0) return null; // Remove entirely
      if (filteredIndices.length === v.dates.length) return v; // No changes
      
      return {
        ...v,
        dates: filteredIndices.map(i => v.dates[i]),
        n_daily: filteredIndices.map(i => v.n_daily![i]),
        k_daily: filteredIndices.map(i => v.k_daily![i]),
        n: filteredIndices.reduce((sum, i) => sum + v.n_daily![i], 0),
        k: filteredIndices.reduce((sum, i) => sum + v.k_daily![i], 0)
      };
    }).filter((v): v is ParameterValue => v !== null);
    
    return {
      ...paramFile,
      values: [...filteredValues, newValue]
    };
  }
  
  private applyToGraph(
    graph: Graph,
    edgeId: string,
    paramFile: ParameterFile,
    windowStart: Date,
    windowEnd: Date,
    querySignature: string
  ): Graph {
    const edge = graph.edges.find(e => e.uuid === edgeId);
    if (!edge) return graph;
    
    // Aggregate data for the requested window
    let totalN = 0;
    let totalK = 0;
    
    for (const value of paramFile.values) {
      if (value.query_signature && value.query_signature !== querySignature) continue;
      if (!value.dates || !value.n_daily || !value.k_daily) continue;
      
      for (let i = 0; i < value.dates.length; i++) {
        const date = new Date(value.dates[i]);
        if (date >= windowStart && date <= windowEnd) {
          totalN += value.n_daily[i];
          totalK += value.k_daily[i];
        }
      }
    }
    
    const updatedEdge = {
      ...edge,
      p: {
        ...edge.p,
        mean: totalN > 0 ? totalK / totalN : 0,
        evidence: {
          n: totalN,
          k: totalK,
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
// TEST HELPERS
// ============================================================================

function createTestGraph(options: { currentQueryDSL?: string } = {}): Graph {
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
      p: { id: 'test-param', connection: 'amplitude-prod', mean: 0.5 }
    }],
    currentQueryDSL: options.currentQueryDSL
  };
}

function formatDate(date: Date): string {
  const day = date.getUTCDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getUTCMonth()];
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${day}-${month}-${year}`;
}

// ============================================================================
// TESTS
// ============================================================================

describe('Parameter Cache E2E Tests', () => {
  let idb: TestIDB;
  let api: MockAmplitudeAPI;
  let service: CacheAwareVersionedFetchService;
  
  beforeAll(() => {
    indexedDB = new IDBFactory();
  });
  
  beforeEach(async () => {
    idb = new TestIDB();
    await idb.init();
    api = new MockAmplitudeAPI();
    service = new CacheAwareVersionedFetchService(idb, api);
  });
  
  afterEach(async () => {
    await idb.clear();
    idb.close();
    api.reset();
  });

  // ===========================================================================
  // SCENARIO 1: Basic Cache Behavior
  // ===========================================================================

  describe('Basic Cache Behavior', () => {
    it('should cache single day and reuse on second request', async () => {
      const graph = createTestGraph();
      
      // First request - should hit API
      const result1 = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)'
      });
      
      expect(result1.fromCache).toBe(false);
      expect(result1.fetchedDays).toBe(1);
      expect(api.getCallCount()).toBe(1);
      
      // Second request - should use cache
      const result2 = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph: result1.graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)'
      });
      
      expect(result2.fromCache).toBe(true);
      expect(result2.fetchedDays).toBe(0);
      expect(api.getCallCount()).toBe(1); // No new API calls
    });

    it('should cache 7-day range and reuse entirely', async () => {
      const graph = createTestGraph();
      
      // Fetch Oct 1-7
      const result1 = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:7-Oct-25)'
      });
      
      expect(result1.fromCache).toBe(false);
      expect(result1.fetchedDays).toBe(7);
      
      // Request Oct 3-5 (subset) - should use cache
      const result2 = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph: result1.graph,
        currentDSL: 'window(3-Oct-25:5-Oct-25)'
      });
      
      expect(result2.fromCache).toBe(true);
      expect(api.getCallCount()).toBe(1); // No new API calls
    });

    it('should cache 30-day range and serve subranges', async () => {
      const graph = createTestGraph();
      
      // Fetch entire October
      const result1 = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:31-Oct-25)'
      });
      
      expect(result1.fetchedDays).toBe(31);
      
      // Request various subranges - all should be cached
      const subranges = [
        'window(1-Oct-25:1-Oct-25)',   // First day
        'window(15-Oct-25:15-Oct-25)', // Middle day
        'window(31-Oct-25:31-Oct-25)', // Last day
        'window(10-Oct-25:20-Oct-25)', // Middle range
      ];
      
      for (const dsl of subranges) {
        const result = await service.getFromSource({
          paramId: 'test-param',
          edgeId: 'edge-1',
          graph: result1.graph,
          currentDSL: dsl
        });
        expect(result.fromCache).toBe(true);
      }
      
      expect(api.getCallCount()).toBe(1); // Only the initial call
    });
  });

  // ===========================================================================
  // SCENARIO 2: Incremental Fetch (Partial Cache)
  // ===========================================================================

  describe('Incremental Fetch (Partial Cache)', () => {
    it('should fetch only missing dates when cache is partial', async () => {
      const graph = createTestGraph();
      
      // Pre-populate cache with Oct 1-10
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:10-Oct-25)'
      });
      
      expect(api.getCallCount()).toBe(1);
      expect(api.callLog[0].start).toBe('2025-10-01');
      expect(api.callLog[0].end).toBe('2025-10-10');
      
      // Request Oct 5-15 - should only fetch Oct 11-15
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(5-Oct-25:15-Oct-25)'
      });
      
      expect(result.fromCache).toBe(false); // Had to fetch some
      expect(api.getCallCount()).toBe(2);
      expect(api.callLog[1].start).toBe('2025-10-11');
      expect(api.callLog[1].end).toBe('2025-10-15');
    });

    it('should fetch multiple gaps efficiently', async () => {
      const graph = createTestGraph();
      
      // Pre-populate with Oct 5-10 and Oct 20-25
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(5-Oct-25:10-Oct-25)'
      });
      
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(20-Oct-25:25-Oct-25)'
      });
      
      expect(api.getCallCount()).toBe(2);
      
      // Request Oct 1-31 - should fetch gaps: Oct 1-4, Oct 11-19, Oct 26-31
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:31-Oct-25)'
      });
      
      expect(result.fromCache).toBe(false);
      
      // Should have made calls for the gaps
      const gapCalls = api.callLog.slice(2); // Skip first 2 calls
      expect(gapCalls.length).toBeGreaterThanOrEqual(1);
      
      // Verify we didn't re-fetch cached dates
      const fetchedDates = new Set<string>();
      for (const call of gapCalls) {
        const start = new Date(call.start);
        const end = new Date(call.end);
        const current = new Date(start);
        while (current <= end) {
          fetchedDates.add(current.toISOString().split('T')[0]);
          current.setUTCDate(current.getUTCDate() + 1);
        }
      }
      
      // Should NOT have re-fetched Oct 5-10 or Oct 20-25
      expect(fetchedDates.has('2025-10-05')).toBe(false);
      expect(fetchedDates.has('2025-10-10')).toBe(false);
      expect(fetchedDates.has('2025-10-20')).toBe(false);
      expect(fetchedDates.has('2025-10-25')).toBe(false);
    });

    it('should handle extending cache forward', async () => {
      const graph = createTestGraph();
      
      // Cache Oct 1-15
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:15-Oct-25)'
      });
      
      // Request Oct 1-31 (extend forward)
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:31-Oct-25)'
      });
      
      // Should only fetch Oct 16-31
      expect(api.getCallCount()).toBe(2);
      expect(api.callLog[1].start).toBe('2025-10-16');
      expect(api.callLog[1].end).toBe('2025-10-31');
    });

    it('should handle extending cache backward', async () => {
      const graph = createTestGraph();
      
      // Cache Oct 15-31
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(15-Oct-25:31-Oct-25)'
      });
      
      // Request Oct 1-31 (extend backward)
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:31-Oct-25)'
      });
      
      // Should only fetch Oct 1-14
      expect(api.getCallCount()).toBe(2);
      expect(api.callLog[1].start).toBe('2025-10-01');
      expect(api.callLog[1].end).toBe('2025-10-14');
    });
  });

  // ===========================================================================
  // SCENARIO 3: Bust Cache
  // ===========================================================================

  describe('Bust Cache Behavior', () => {
    it('should re-fetch all dates when bustCache=true', async () => {
      const graph = createTestGraph();
      
      // Initial fetch
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:7-Oct-25)'
      });
      
      expect(api.getCallCount()).toBe(1);
      
      // Request same range with bust cache
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:7-Oct-25)',
        bustCache: true
      });
      
      // Should have fetched again
      expect(api.getCallCount()).toBe(2);
      expect(api.callLog[1].start).toBe('2025-10-01');
      expect(api.callLog[1].end).toBe('2025-10-07');
    });

    it('should update data when bust cache returns different values', async () => {
      const graph = createTestGraph();
      
      // Set specific response for first fetch
      api.setResponseForRange('2025-10-01', '2025-10-01', [
        { date: '2025-10-01', n: 100, k: 50 }
      ]);
      
      const result1 = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)'
      });
      
      const edge1 = result1.graph.edges.find(e => e.uuid === 'edge-1');
      expect(edge1?.p.evidence?.n).toBe(100);
      expect(edge1?.p.evidence?.k).toBe(50);
      
      // Set different response for bust cache
      api.setResponseForRange('2025-10-01', '2025-10-01', [
        { date: '2025-10-01', n: 200, k: 100 }
      ]);
      
      const result2 = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph: result1.graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)',
        bustCache: true
      });
      
      const edge2 = result2.graph.edges.find(e => e.uuid === 'edge-1');
      expect(edge2?.p.evidence?.n).toBe(200);
      expect(edge2?.p.evidence?.k).toBe(100);
    });
  });

  // ===========================================================================
  // SCENARIO 4: Query Signature Matching
  // ===========================================================================

  describe('Query Signature Matching', () => {
    it('should NOT reuse cache for different query signatures', async () => {
      const graph = createTestGraph();
      
      // Fetch with signature A
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:7-Oct-25)',
        querySignature: 'sig-query-A'
      });
      
      expect(api.getCallCount()).toBe(1);
      
      // Fetch same dates with different signature - should NOT use cache
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:7-Oct-25)',
        querySignature: 'sig-query-B'
      });
      
      expect(api.getCallCount()).toBe(2); // New fetch required
    });

    it('should maintain separate cache per query signature', async () => {
      const graph = createTestGraph();
      
      // Set different responses for each signature
      api.setResponseForRange('2025-10-01', '2025-10-01', [
        { date: '2025-10-01', n: 100, k: 50 }
      ]);
      
      // Fetch with signature A
      const resultA = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)',
        querySignature: 'sig-A'
      });
      
      // Change response
      api.setResponseForRange('2025-10-01', '2025-10-01', [
        { date: '2025-10-01', n: 200, k: 100 }
      ]);
      
      // Fetch with signature B
      const resultB = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)',
        querySignature: 'sig-B'
      });
      
      // Should have different results
      const edgeA = resultA.graph.edges.find(e => e.uuid === 'edge-1');
      const edgeB = resultB.graph.edges.find(e => e.uuid === 'edge-1');
      
      expect(edgeA?.p.evidence?.n).toBe(100);
      expect(edgeB?.p.evidence?.n).toBe(200);
    });
  });

  // ===========================================================================
  // SCENARIO 5: Multiple Parameters
  // ===========================================================================

  describe('Multiple Parameters', () => {
    it('should maintain separate cache for each parameter', async () => {
      const graph: Graph = {
        nodes: [
          { uuid: 'node-a', id: 'from' },
          { uuid: 'node-b', id: 'to' },
          { uuid: 'node-c', id: 'other' }
        ],
        edges: [
          { uuid: 'edge-1', id: 'edge-1', from: 'node-a', to: 'node-b', query: 'from(a).to(b)', p: { id: 'param-1' } },
          { uuid: 'edge-2', id: 'edge-2', from: 'node-a', to: 'node-c', query: 'from(a).to(c)', p: { id: 'param-2' } }
        ]
      };
      
      // Fetch param-1
      await service.getFromSource({
        paramId: 'param-1',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:7-Oct-25)'
      });
      
      expect(api.getCallCount()).toBe(1);
      
      // Fetch param-2 for same dates - should NOT reuse param-1's cache
      await service.getFromSource({
        paramId: 'param-2',
        edgeId: 'edge-2',
        graph,
        currentDSL: 'window(1-Oct-25:7-Oct-25)'
      });
      
      expect(api.getCallCount()).toBe(2);
      
      // Re-fetch param-1 - should use cache
      const result = await service.getFromSource({
        paramId: 'param-1',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:7-Oct-25)'
      });
      
      expect(result.fromCache).toBe(true);
      expect(api.getCallCount()).toBe(2); // No new call
    });
  });

  // ===========================================================================
  // SCENARIO 6: Aggregation Window Accuracy
  // ===========================================================================

  describe('Aggregation Window Accuracy', () => {
    it('should aggregate ONLY dates within requested window', async () => {
      const graph = createTestGraph();
      
      // Set specific daily values
      api.setResponseForRange('2025-10-01', '2025-10-05', [
        { date: '2025-10-01', n: 100, k: 10 },  // Day 1: 10%
        { date: '2025-10-02', n: 100, k: 20 },  // Day 2: 20%
        { date: '2025-10-03', n: 100, k: 30 },  // Day 3: 30%
        { date: '2025-10-04', n: 100, k: 40 },  // Day 4: 40%
        { date: '2025-10-05', n: 100, k: 50 },  // Day 5: 50%
      ]);
      
      // Fetch all 5 days
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:5-Oct-25)'
      });
      
      // Request ONLY day 3
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(3-Oct-25:3-Oct-25)'
      });
      
      const edge = result.graph.edges.find(e => e.uuid === 'edge-1');
      
      // Should have ONLY day 3 data (n=100, k=30)
      expect(edge?.p.evidence?.n).toBe(100);
      expect(edge?.p.evidence?.k).toBe(30);
      expect(edge?.p.mean).toBeCloseTo(0.3, 5);
    });

    it('should correctly aggregate multi-day ranges', async () => {
      const graph = createTestGraph();
      
      api.setResponseForRange('2025-10-01', '2025-10-03', [
        { date: '2025-10-01', n: 100, k: 50 },
        { date: '2025-10-02', n: 200, k: 80 },
        { date: '2025-10-03', n: 150, k: 60 },
      ]);
      
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:3-Oct-25)'
      });
      
      const edge = result.graph.edges.find(e => e.uuid === 'edge-1');
      
      // Total: n = 100+200+150 = 450, k = 50+80+60 = 190
      expect(edge?.p.evidence?.n).toBe(450);
      expect(edge?.p.evidence?.k).toBe(190);
      expect(edge?.p.mean).toBeCloseTo(190/450, 5);
    });
  });

  // ===========================================================================
  // SCENARIO 7: Cross-Month Ranges
  // ===========================================================================

  describe('Cross-Month Ranges', () => {
    it('should handle ranges spanning multiple months', async () => {
      const graph = createTestGraph();
      
      // Fetch Sep 25 - Oct 5
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(25-Sep-25:5-Oct-25)'
      });
      
      expect(result.fetchedDays).toBe(11); // Sep 25-30 (6 days) + Oct 1-5 (5 days)
      
      // Verify cache covers both months
      const result2 = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(28-Sep-25:2-Oct-25)'
      });
      
      expect(result2.fromCache).toBe(true);
    });

    it('should handle year boundary', async () => {
      const graph = createTestGraph();
      
      // Fetch Dec 28 2024 - Jan 5 2025
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(28-Dec-24:5-Jan-25)'
      });
      
      expect(result.fetchedDays).toBe(9); // Dec 28-31 (4 days) + Jan 1-5 (5 days)
    });
  });

  // ===========================================================================
  // SCENARIO 8: Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle same-day start and end', async () => {
      const graph = createTestGraph();
      
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(15-Oct-25:15-Oct-25)'
      });
      
      expect(result.fetchedDays).toBe(1);
      expect(api.getCallCount()).toBe(1);
    });

    it('should handle very long ranges (90 days)', async () => {
      const graph = createTestGraph();
      
      const result = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:31-Dec-25)'
      });
      
      expect(result.fetchedDays).toBe(92); // Oct (31) + Nov (30) + Dec (31)
    });

    it('should handle empty cache gracefully', async () => {
      const graph = createTestGraph();
      
      const result = await service.getFromSource({
        paramId: 'new-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:1-Oct-25)'
      });
      
      expect(result.fromCache).toBe(false);
      expect(result.fetchedDays).toBe(1);
    });

    it('should throw on invalid DSL format', async () => {
      const graph = createTestGraph();
      
      await expect(
        service.getFromSource({
          paramId: 'test-param',
          edgeId: 'edge-1',
          graph,
          currentDSL: 'window(1-Oct-25,1-Oct-25)' // Comma instead of colon
        })
      ).rejects.toThrow('Invalid DSL');
    });
  });

  // ===========================================================================
  // SCENARIO 9: Real-World Workflow Simulation
  // ===========================================================================

  describe('Real-World Workflow Simulation', () => {
    it('should simulate user exploring different date ranges', async () => {
      const graph = createTestGraph();
      
      // User starts with last 7 days
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(24-Oct-25:31-Oct-25)'
      });
      expect(api.getCallCount()).toBe(1);
      
      // User zooms into a specific day - should use cache
      const day1 = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(27-Oct-25:27-Oct-25)'
      });
      expect(day1.fromCache).toBe(true);
      expect(api.getCallCount()).toBe(1);
      
      // User expands to last 14 days - should fetch missing week
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(17-Oct-25:31-Oct-25)'
      });
      expect(api.getCallCount()).toBe(2);
      
      // User goes back to original 7 days - should be fully cached
      const week1 = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(24-Oct-25:31-Oct-25)'
      });
      expect(week1.fromCache).toBe(true);
      expect(api.getCallCount()).toBe(2);
      
      // User expands to full month - should fetch remaining days
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:31-Oct-25)'
      });
      expect(api.getCallCount()).toBe(3);
      
      // Any October date should now be cached
      const anyDay = await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(5-Oct-25:5-Oct-25)'
      });
      expect(anyDay.fromCache).toBe(true);
      expect(api.getCallCount()).toBe(3);
    });

    it('should simulate batch fetch then individual queries', async () => {
      const graph = createTestGraph();
      
      // Batch: Fetch entire Q4
      await service.getFromSource({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        currentDSL: 'window(1-Oct-25:31-Dec-25)'
      });
      expect(api.getCallCount()).toBe(1);
      expect(api.callLog[0].start).toBe('2025-10-01');
      expect(api.callLog[0].end).toBe('2025-12-31');
      
      // Individual queries - all should be cached
      const queries = [
        'window(15-Oct-25:15-Oct-25)',
        'window(1-Nov-25:7-Nov-25)',
        'window(25-Dec-25:31-Dec-25)',
        'window(1-Oct-25:31-Oct-25)',
        'window(15-Nov-25:15-Dec-25)',
      ];
      
      for (const dsl of queries) {
        const result = await service.getFromSource({
          paramId: 'test-param',
          edgeId: 'edge-1',
          graph,
          currentDSL: dsl
        });
        expect(result.fromCache).toBe(true);
      }
      
      // Total API calls should still be 1
      expect(api.getCallCount()).toBe(1);
    });
  });
});

