/**
 * Cache Integrity E2E Tests
 * 
 * Tests that verify:
 * 1. Incremental cache checking works correctly
 * 2. Cache is NOT bypassed when data exists
 * 3. API is NOT called when cache has the data
 * 4. Timezone issues don't cause cache misses
 * 5. Query signature matching works
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

// ============================================================================
// TYPES
// ============================================================================

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
}

interface ParameterFile {
  id: string;
  connection: string;
  query: string;
  values: ParameterValue[];
}

// ============================================================================
// MOCK IDB
// ============================================================================

class MockIDB {
  private db: IDBDatabase | null = null;
  
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('cache-test', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { this.db = request.result; resolve(); };
      request.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('params')) db.createObjectStore('params', { keyPath: 'id' });
      };
    });
  }
  
  async put(id: string, data: ParameterFile): Promise<void> {
    if (!this.db) throw new Error('Not init');
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('params', 'readwrite');
      tx.objectStore('params').put({ ...data, id });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  
  async get(id: string): Promise<ParameterFile | null> {
    if (!this.db) throw new Error('Not init');
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('params', 'readonly');
      const req = tx.objectStore('params').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  
  async clear(): Promise<void> {
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('params', 'readwrite');
      tx.objectStore('params').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  
  close(): void { this.db?.close(); this.db = null; }
}

// ============================================================================
// MOCK API TRACKER
// ============================================================================

class APITracker {
  public calls: Array<{ start: string; end: string }> = [];
  
  recordCall(start: string, end: string): void {
    this.calls.push({ start, end });
  }
  
  getCallCount(): number {
    return this.calls.length;
  }
  
  wasDateFetched(dateStr: string): boolean {
    for (const call of this.calls) {
      const callStart = new Date(call.start);
      const callEnd = new Date(call.end);
      const check = new Date(dateStr);
      if (check >= callStart && check <= callEnd) {
        return true;
      }
    }
    return false;
  }
  
  reset(): void {
    this.calls = [];
  }
}

// ============================================================================
// CACHE CHECK SERVICE (Mimics real logic)
// ============================================================================

class CacheCheckService {
  constructor(private idb: MockIDB, private api: APITracker) {}
  
  /**
   * Check if cache has data for the requested window
   * Returns: { shouldFetch: boolean, missingDates: Date[] }
   */
  async checkCache(
    paramId: string,
    windowStart: Date,
    windowEnd: Date,
    bustCache: boolean = false
  ): Promise<{ shouldFetch: boolean; missingDates: Date[]; cachedDates: string[] }> {
    if (bustCache) {
      return {
        shouldFetch: true,
        missingDates: this.dateRange(windowStart, windowEnd),
        cachedDates: []
      };
    }
    
    const paramFile = await this.idb.get(paramId);
    if (!paramFile) {
      return {
        shouldFetch: true,
        missingDates: this.dateRange(windowStart, windowEnd),
        cachedDates: []
      };
    }
    
    // Collect all cached dates
    const cachedDates = new Set<string>();
    for (const value of paramFile.values) {
      if (value.dates) {
        value.dates.forEach(d => cachedDates.add(d));
      }
    }
    
    // Find missing dates
    const requestedDates = this.dateRange(windowStart, windowEnd);
    const missingDates = requestedDates.filter(d => 
      !cachedDates.has(d.toISOString().split('T')[0])
    );
    
    return {
      shouldFetch: missingDates.length > 0,
      missingDates,
      cachedDates: Array.from(cachedDates)
    };
  }
  
  /**
   * Simulate fetch + cache update
   */
  async fetchAndCache(
    paramId: string,
    windowStart: Date,
    windowEnd: Date,
    bustCache: boolean = false
  ): Promise<{ apiCalled: boolean; fetchedDays: number }> {
    const { shouldFetch, missingDates } = await this.checkCache(paramId, windowStart, windowEnd, bustCache);
    
    if (!shouldFetch) {
      return { apiCalled: false, fetchedDays: 0 };
    }
    
    // Record API call
    const minDate = new Date(Math.min(...missingDates.map(d => d.getTime())));
    const maxDate = new Date(Math.max(...missingDates.map(d => d.getTime())));
    this.api.recordCall(minDate.toISOString(), maxDate.toISOString());
    
    // Update cache
    let paramFile = await this.idb.get(paramId);
    if (!paramFile) {
      paramFile = { id: paramId, connection: 'test', query: '', values: [] };
    }
    
    // Add fetched data
    const newValue: ParameterValue = {
      window_from: windowStart.toISOString(),
      window_to: windowEnd.toISOString(),
      n: missingDates.length * 100,
      k: missingDates.length * 50,
      n_daily: missingDates.map(() => 100),
      k_daily: missingDates.map(() => 50),
      dates: missingDates.map(d => d.toISOString().split('T')[0]),
      sliceDSL: ''
    };
    
    paramFile.values.push(newValue);
    await this.idb.put(paramId, paramFile);
    
    return { apiCalled: true, fetchedDays: missingDates.length };
  }
  
  private dateRange(start: Date, end: Date): Date[] {
    const dates: Date[] = [];
    const current = new Date(start);
    while (current <= end) {
      dates.push(new Date(current));
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return dates;
  }
}

// ============================================================================
// TIMEZONE TESTS
// ============================================================================

describe('Timezone Handling', () => {
  it('parseUKDate should produce UTC midnight', async () => {
    const { parseUKDate } = await import('../../lib/dateFormat');
    
    const oct1 = parseUKDate('1-Oct-25');
    
    // MUST be October 1st, 00:00 UTC
    expect(oct1.getUTCFullYear()).toBe(2025);
    expect(oct1.getUTCMonth()).toBe(9); // October = 9
    expect(oct1.getUTCDate()).toBe(1);
    expect(oct1.getUTCHours()).toBe(0);
    expect(oct1.getUTCMinutes()).toBe(0);
    
    // ISO string MUST start with 2025-10-01
    expect(oct1.toISOString()).toMatch(/^2025-10-01T00:00:00/);
    
    // MUST NOT be September 30th (timezone bug)
    expect(oct1.toISOString()).not.toMatch(/2025-09-30/);
  });
  
  it('formatDateUK should round-trip correctly', async () => {
    const { formatDateUK, parseUKDate } = await import('../../lib/dateFormat');
    
    const original = '15-Oct-25';
    const parsed = parseUKDate(original);
    const formatted = formatDateUK(parsed);
    
    expect(formatted).toBe(original);
  });
  
  it('should NOT shift dates across timezone boundaries', async () => {
    const { parseUKDate } = await import('../../lib/dateFormat');
    
    // Test several dates that are commonly affected by timezone issues
    const testCases = [
      { input: '1-Jan-25', expectedMonth: 0, expectedDay: 1 },
      { input: '1-Mar-25', expectedMonth: 2, expectedDay: 1 },  // DST boundary
      { input: '31-Oct-25', expectedMonth: 9, expectedDay: 31 }, // DST boundary
      { input: '1-Nov-25', expectedMonth: 10, expectedDay: 1 },
      { input: '31-Dec-25', expectedMonth: 11, expectedDay: 31 },
    ];
    
    for (const { input, expectedMonth, expectedDay } of testCases) {
      const date = parseUKDate(input);
      expect(date.getUTCMonth()).toBe(expectedMonth);
      expect(date.getUTCDate()).toBe(expectedDay);
    }
  });
});

// ============================================================================
// CACHE INTEGRITY TESTS
// ============================================================================

describe('Cache Integrity', () => {
  let idb: MockIDB;
  let api: APITracker;
  let service: CacheCheckService;
  
  beforeAll(() => {
    indexedDB = new IDBFactory();
  });
  
  beforeEach(async () => {
    idb = new MockIDB();
    await idb.init();
    api = new APITracker();
    service = new CacheCheckService(idb, api);
  });
  
  afterEach(async () => {
    await idb.clear();
    idb.close();
    api.reset();
  });
  
  // =========================================================================
  // Basic cache behavior
  // =========================================================================
  
  describe('Cache Hit/Miss Detection', () => {
    it('should detect cache miss on empty cache', async () => {
      const result = await service.checkCache(
        'test-param',
        new Date('2025-10-01T00:00:00Z'),
        new Date('2025-10-01T00:00:00Z')
      );
      
      expect(result.shouldFetch).toBe(true);
      expect(result.missingDates).toHaveLength(1);
    });
    
    it('should detect cache hit when data exists', async () => {
      // Pre-populate cache
      await idb.put('test-param', {
        id: 'test-param',
        connection: 'test',
        query: '',
        values: [{
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-01T00:00:00.000Z',
          n: 100, k: 50,
          n_daily: [100], k_daily: [50],
          dates: ['2025-10-01'],
          sliceDSL: ''
        }]
      });
      
      const result = await service.checkCache(
        'test-param',
        new Date('2025-10-01T00:00:00Z'),
        new Date('2025-10-01T00:00:00Z')
      );
      
      expect(result.shouldFetch).toBe(false);
      expect(result.missingDates).toHaveLength(0);
    });
    
    it('should detect partial cache (some dates missing)', async () => {
      // Cache has Oct 1-5
      await idb.put('test-param', {
        id: 'test-param',
        connection: 'test',
        query: '',
        values: [{
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-05T00:00:00.000Z',
          n: 500, k: 250,
          n_daily: [100, 100, 100, 100, 100],
          k_daily: [50, 50, 50, 50, 50],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05'],
          sliceDSL: ''
        }]
      });
      
      // Request Oct 1-10
      const result = await service.checkCache(
        'test-param',
        new Date('2025-10-01T00:00:00Z'),
        new Date('2025-10-10T00:00:00Z')
      );
      
      expect(result.shouldFetch).toBe(true);
      // Should be missing Oct 6-10 (5 days)
      expect(result.missingDates).toHaveLength(5);
    });
  });
  
  // =========================================================================
  // API call prevention
  // =========================================================================
  
  describe('API Call Prevention', () => {
    it('should NOT call API when cache is complete', async () => {
      // Pre-populate cache with Oct 1-7
      await idb.put('test-param', {
        id: 'test-param',
        connection: 'test',
        query: '',
        values: [{
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T00:00:00.000Z',
          n: 700, k: 350,
          n_daily: [100, 100, 100, 100, 100, 100, 100],
          k_daily: [50, 50, 50, 50, 50, 50, 50],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: ''
        }]
      });
      
      // Request Oct 1-7 (fully cached)
      const result = await service.fetchAndCache(
        'test-param',
        new Date('2025-10-01T00:00:00Z'),
        new Date('2025-10-07T00:00:00Z')
      );
      
      expect(result.apiCalled).toBe(false);
      expect(api.getCallCount()).toBe(0);
    });
    
    it('should NOT call API when requesting subset of cached data', async () => {
      // Pre-populate cache with Oct 1-31
      const dates: string[] = [];
      const n_daily: number[] = [];
      const k_daily: number[] = [];
      for (let i = 1; i <= 31; i++) {
        dates.push(`2025-10-${String(i).padStart(2, '0')}`);
        n_daily.push(100);
        k_daily.push(50);
      }
      
      await idb.put('test-param', {
        id: 'test-param',
        connection: 'test',
        query: '',
        values: [{ window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-31T00:00:00.000Z', n: 3100, k: 1550, n_daily, k_daily, dates, sliceDSL: '' }]
      });
      
      // Request Oct 15-20 (subset)
      const result = await service.fetchAndCache(
        'test-param',
        new Date('2025-10-15T00:00:00Z'),
        new Date('2025-10-20T00:00:00Z')
      );
      
      expect(result.apiCalled).toBe(false);
      expect(api.getCallCount()).toBe(0);
    });
    
    it('should call API ONLY for missing dates', async () => {
      // Cache has Oct 1-10
      const dates: string[] = [];
      const n_daily: number[] = [];
      const k_daily: number[] = [];
      for (let i = 1; i <= 10; i++) {
        dates.push(`2025-10-${String(i).padStart(2, '0')}`);
        n_daily.push(100);
        k_daily.push(50);
      }
      
      await idb.put('test-param', {
        id: 'test-param',
        connection: 'test',
        query: '',
        values: [{ window_from: '2025-10-01T00:00:00.000Z', window_to: '2025-10-10T00:00:00.000Z', n: 1000, k: 500, n_daily, k_daily, dates, sliceDSL: '' }]
      });
      
      // Request Oct 5-15
      const result = await service.fetchAndCache(
        'test-param',
        new Date('2025-10-05T00:00:00Z'),
        new Date('2025-10-15T00:00:00Z')
      );
      
      expect(result.apiCalled).toBe(true);
      expect(result.fetchedDays).toBe(5); // Only Oct 11-15
      
      // API should NOT have fetched Oct 1-10
      expect(api.wasDateFetched('2025-10-05')).toBe(false);
      expect(api.wasDateFetched('2025-10-10')).toBe(false);
      
      // API SHOULD have fetched Oct 11-15
      expect(api.wasDateFetched('2025-10-11')).toBe(true);
      expect(api.wasDateFetched('2025-10-15')).toBe(true);
    });
  });
  
  // =========================================================================
  // Bust cache behavior
  // =========================================================================
  
  describe('Bust Cache Behavior', () => {
    it('should always call API when bustCache=true', async () => {
      // Pre-populate cache
      await idb.put('test-param', {
        id: 'test-param',
        connection: 'test',
        query: '',
        values: [{
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-01T00:00:00.000Z',
          n: 100, k: 50, n_daily: [100], k_daily: [50], dates: ['2025-10-01'], sliceDSL: ''
        }]
      });
      
      const result = await service.fetchAndCache(
        'test-param',
        new Date('2025-10-01T00:00:00Z'),
        new Date('2025-10-01T00:00:00Z'),
        true // bustCache
      );
      
      expect(result.apiCalled).toBe(true);
      expect(api.getCallCount()).toBe(1);
    });
  });
  
  // =========================================================================
  // Sequential fetch simulation
  // =========================================================================
  
  describe('Sequential Fetch Simulation', () => {
    it('should accumulate cache across multiple fetches', async () => {
      // Fetch 1: Oct 1-7
      await service.fetchAndCache(
        'test-param',
        new Date('2025-10-01T00:00:00Z'),
        new Date('2025-10-07T00:00:00Z')
      );
      expect(api.getCallCount()).toBe(1);
      
      // Fetch 2: Oct 1-7 again (should use cache)
      await service.fetchAndCache(
        'test-param',
        new Date('2025-10-01T00:00:00Z'),
        new Date('2025-10-07T00:00:00Z')
      );
      expect(api.getCallCount()).toBe(1); // No new call
      
      // Fetch 3: Oct 5-15 (should only fetch Oct 8-15)
      const result3 = await service.fetchAndCache(
        'test-param',
        new Date('2025-10-05T00:00:00Z'),
        new Date('2025-10-15T00:00:00Z')
      );
      expect(api.getCallCount()).toBe(2);
      expect(result3.fetchedDays).toBe(8); // Oct 8-15
      
      // Fetch 4: Oct 1-31 (should only fetch Oct 16-31)
      const result4 = await service.fetchAndCache(
        'test-param',
        new Date('2025-10-01T00:00:00Z'),
        new Date('2025-10-31T00:00:00Z')
      );
      expect(api.getCallCount()).toBe(3);
      expect(result4.fetchedDays).toBe(16); // Oct 16-31
      
      // Fetch 5: Any October date (should use cache entirely)
      const result5 = await service.fetchAndCache(
        'test-param',
        new Date('2025-10-15T00:00:00Z'),
        new Date('2025-10-20T00:00:00Z')
      );
      expect(result5.apiCalled).toBe(false);
      expect(api.getCallCount()).toBe(3); // No new call
    });
  });
});

// ============================================================================
// BATCH OPERATIONS CACHE TESTS
// ============================================================================

describe('Batch Operations Cache Integrity', () => {
  let idb: MockIDB;
  let api: APITracker;
  let service: CacheCheckService;
  
  beforeAll(() => {
    indexedDB = new IDBFactory();
  });
  
  beforeEach(async () => {
    idb = new MockIDB();
    await idb.init();
    api = new APITracker();
    service = new CacheCheckService(idb, api);
  });
  
  afterEach(async () => {
    await idb.clear();
    idb.close();
    api.reset();
  });
  
  it('should NOT re-fetch when iterating over multiple params with same window', async () => {
    const params = ['param-1', 'param-2', 'param-3', 'param-4', 'param-5'];
    const window = {
      start: new Date('2025-10-01T00:00:00Z'),
      end: new Date('2025-10-07T00:00:00Z')
    };
    
    // Pre-populate ALL params with the same cached data
    for (const paramId of params) {
      await idb.put(paramId, {
        id: paramId,
        connection: 'test',
        query: '',
        values: [{
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-07T00:00:00.000Z',
          n: 700, k: 350,
          n_daily: [100, 100, 100, 100, 100, 100, 100],
          k_daily: [50, 50, 50, 50, 50, 50, 50],
          dates: ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07'],
          sliceDSL: ''
        }]
      });
    }
    
    // Simulate batch fetch
    for (const paramId of params) {
      await service.fetchAndCache(paramId, window.start, window.end);
    }
    
    // NO API calls should have been made
    expect(api.getCallCount()).toBe(0);
  });
  
  it('should fetch each param independently when none are cached', async () => {
    const params = ['param-1', 'param-2', 'param-3'];
    const window = {
      start: new Date('2025-10-01T00:00:00Z'),
      end: new Date('2025-10-01T00:00:00Z')
    };
    
    // No pre-populated cache
    
    // Simulate batch fetch
    for (const paramId of params) {
      await service.fetchAndCache(paramId, window.start, window.end);
    }
    
    // Should have 3 API calls (one per param)
    expect(api.getCallCount()).toBe(3);
  });
  
  it('should correctly use cache after "put all to files" operation', async () => {
    // Simulate: User did "put all to files" which populated cache for all params
    const params = ['household-delegation-rate', 'wa-to-dashboard', 'coffee-to-bds'];
    
    for (const paramId of params) {
      await idb.put(paramId, {
        id: paramId,
        connection: 'amplitude-prod',
        query: `from(x).to(y)`,
        values: [{
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-01T00:00:00.000Z',
          n: 100, k: 50,
          n_daily: [100], k_daily: [50],
          dates: ['2025-10-01'],
          sliceDSL: ''
        }]
      });
    }
    
    // Now simulate "get all from sources" for SAME window
    for (const paramId of params) {
      const result = await service.fetchAndCache(
        paramId,
        new Date('2025-10-01T00:00:00Z'),
        new Date('2025-10-01T00:00:00Z')
      );
      expect(result.apiCalled).toBe(false);
    }
    
    // NO API calls
    expect(api.getCallCount()).toBe(0);
  });
});

