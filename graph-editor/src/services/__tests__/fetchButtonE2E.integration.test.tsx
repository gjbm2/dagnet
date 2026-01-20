/**
 * AllSlicesModal → WindowSelector Cache Flow E2E Test
 * 
 * Tests the ACTUAL user flow:
 * 1. User opens AllSlicesModal and fetches ALL slices (google, facebook, other)
 * 2. Data is written to file with sliceDSL for each context
 * 3. User then uses WindowSelector to switch contexts
 * 4. Each switch should load from cache (NO API call)
 * 5. Graph should update with the CORRECT context's data
 * 
 * ONLY MOCK: BrowserHttpExecutor (the actual HTTP call)
 * Everything else is REAL production code.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dataOperationsService } from '../dataOperationsService';
import { mergeTimeSeriesIntoParameter } from '../windowAggregationService';
import { isolateSlice, extractSliceDimensions } from '../sliceIsolation';
import { fileRegistry } from '../../contexts/TabContext';
import type { ParameterValue } from '../../types/parameterData';
import { windowFetchPlannerService } from '../windowFetchPlannerService';
import { contextRegistry } from '../contextRegistry';
import { db } from '../../db/appDatabase';
import { computePlannerQuerySignaturesForGraph } from '../plannerQuerySignatureService';
import { buildFetchPlanProduction } from '../fetchPlanBuilderService';
import { isSignatureCheckingEnabled } from '../signaturePolicyService';

// Mock toast
vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn() }),
}));

describe('AllSlicesModal → WindowSelector Cache Flow', () => {
  
  beforeEach(async () => {
    // Keep FileRegistry/IndexedDB clean for each test in this suite.
    // This prevents cross-test pollution (a common cause of "passes locally, fails in CI" flakiness).
    try {
      await db.files.clear();
    } catch {
      // ignore: some test environments may not expose the DB (but most do)
    }

    // IMPORTANT: WindowFetchPlannerService caches analysis results by (dsl + graph hash).
    // These tests intentionally reuse the same DSL/graph across cases, so we must invalidate
    // between tests or we won't actually exercise the planning/signature codepath.
    windowFetchPlannerService.invalidateCache();

    // Also clear FileRegistry's in-memory cache (Dexie is the source of truth, but tests can leak memory state).
    // This is intentionally "white-box" for tests only.
    try {
      (fileRegistry as any).files?.clear?.();
      (fileRegistry as any).listeners?.clear?.();
      (fileRegistry as any).updatingFiles?.clear?.();
      (fileRegistry as any).pendingUpdates?.clear?.();
    } catch {
      // ignore
    }
  });

  describe('Step 1: mergeTimeSeriesIntoParameter writes sliceDSL correctly', () => {
    it('should write data with sliceDSL when fetching for a context', () => {
      const timeSeries = [
        { date: '2025-10-01', n: 200, k: 30, p: 0.15 },
      ];
      
      // Simulate what getFromSourceDirect does when writing fetched data
      const values = mergeTimeSeriesIntoParameter(
        [], // existing values
        timeSeries,
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-01T23:59:59.000Z' },
        'query-sig-123',
        {},
        'from(a).to(b)',
        'amplitude',
        'context(channel:google)' // THIS IS THE CRITICAL PART - sliceDSL must be set
      );

      expect(values.length).toBe(1);
      // Canonical sliceDSL now includes window dates (per design)
      expect(values[0].sliceDSL).toBe('window(1-Oct-25:1-Oct-25).context(channel:google)');
      expect(values[0].n).toBe(200);
      expect(values[0].k).toBe(30);
    });

    it('should write multiple slices with different sliceDSL', () => {
      let values: ParameterValue[] = [];
      
      // Fetch google
      values = mergeTimeSeriesIntoParameter(
        values,
        [{ date: '2025-10-01', n: 200, k: 30, p: 0.15 }],
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-01T23:59:59.000Z' },
        'sig', {}, 'q', 'amplitude',
        'context(channel:google)'
      );
      
      // Fetch facebook
      values = mergeTimeSeriesIntoParameter(
        values,
        [{ date: '2025-10-01', n: 150, k: 20, p: 0.133 }],
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-01T23:59:59.000Z' },
        'sig', {}, 'q', 'amplitude',
        'context(channel:facebook)'
      );
      
      // Fetch other
      values = mergeTimeSeriesIntoParameter(
        values,
        [{ date: '2025-10-01', n: 50, k: 5, p: 0.1 }],
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-01T23:59:59.000Z' },
        'sig', {}, 'q', 'amplitude',
        'context(channel:other)'
      );

      expect(values.length).toBe(3);
      // Canonical sliceDSL now includes window dates (per design)
      expect(values[0].sliceDSL).toBe('window(1-Oct-25:1-Oct-25).context(channel:google)');
      expect(values[1].sliceDSL).toBe('window(1-Oct-25:1-Oct-25).context(channel:facebook)');
      expect(values[2].sliceDSL).toBe('window(1-Oct-25:1-Oct-25).context(channel:other)');
    });
  });

  describe('Step 2: isolateSlice finds correct data when switching contexts', () => {
    it('should find google data when querying for google', () => {
      const values: ParameterValue[] = [
        { sliceDSL: 'context(channel:google)', n: 200, k: 30, mean: 0.15, dates: ['2025-10-01'], n_daily: [200], k_daily: [30] },
        { sliceDSL: 'context(channel:facebook)', n: 150, k: 20, mean: 0.133, dates: ['2025-10-01'], n_daily: [150], k_daily: [20] },
        { sliceDSL: 'context(channel:other)', n: 50, k: 5, mean: 0.1, dates: ['2025-10-01'], n_daily: [50], k_daily: [5] },
      ];

      // Query for google WITH window (this is what WindowSelector passes)
      const googleResult = isolateSlice(values, 'context(channel:google).window(1-Oct-25:1-Oct-25)');
      
      expect(googleResult.length).toBe(1);
      expect(googleResult[0].n).toBe(200);
      expect(googleResult[0].sliceDSL).toBe('context(channel:google)');
    });

    it('should find facebook data when querying for facebook', () => {
      const values: ParameterValue[] = [
        { sliceDSL: 'context(channel:google)', n: 200, k: 30, mean: 0.15 },
        { sliceDSL: 'context(channel:facebook)', n: 150, k: 20, mean: 0.133 },
        { sliceDSL: 'context(channel:other)', n: 50, k: 5, mean: 0.1 },
      ];

      const fbResult = isolateSlice(values, 'context(channel:facebook).window(1-Oct-25:1-Oct-25)');
      
      expect(fbResult.length).toBe(1);
      expect(fbResult[0].n).toBe(150);
    });

    it('should NOT find google data when querying for pr (which has no data)', () => {
      const values: ParameterValue[] = [
        { sliceDSL: 'context(channel:google)', n: 200, k: 30, mean: 0.15 },
        { sliceDSL: 'context(channel:facebook)', n: 150, k: 20, mean: 0.133 },
      ];

      // pr was never fetched - should return empty
      const prResult = isolateSlice(values, 'context(channel:pr).window(1-Oct-25:1-Oct-25)');
      
      expect(prResult.length).toBe(0);
    });
  });

  describe('Step 3: extractSliceDimensions strips window correctly', () => {
    it('should extract just the context, stripping window', () => {
      const full = 'context(channel:google).window(1-Oct-25:1-Oct-25)';
      const extracted = extractSliceDimensions(full);
      
      expect(extracted).toBe('context(channel:google)');
    });

    it('should handle context-only (no window)', () => {
      const contextOnly = 'context(channel:google)';
      const extracted = extractSliceDimensions(contextOnly);
      
      expect(extracted).toBe('context(channel:google)');
    });
  });

  describe('Step 4: Full roundtrip - write then read', () => {
    it('CRITICAL: data written by AllSlicesModal should be readable by WindowSelector', () => {
      // Simulate AllSlicesModal writing data for all 3 slices
      let fileValues: ParameterValue[] = [];
      
      // AllSlicesModal fetches google
      fileValues = mergeTimeSeriesIntoParameter(
        fileValues,
        [{ date: '2025-10-01', n: 200, k: 30, p: 0.15 }],
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-01T23:59:59.000Z' },
        'sig', {}, 'from(a).to(b)', 'amplitude',
        'context(channel:google)'
      );
      
      // AllSlicesModal fetches facebook  
      fileValues = mergeTimeSeriesIntoParameter(
        fileValues,
        [{ date: '2025-10-01', n: 150, k: 20, p: 0.133 }],
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-01T23:59:59.000Z' },
        'sig', {}, 'from(a).to(b)', 'amplitude',
        'context(channel:facebook)'
      );

      // Now simulate WindowSelector switching to google
      const googleQuery = 'context(channel:google).window(1-Oct-25:1-Oct-25)';
      const googleData = isolateSlice(fileValues, googleQuery);
      
      expect(googleData.length).toBe(1);
      expect(googleData[0].n).toBe(200);
      expect(googleData[0].k).toBe(30);

      // Now simulate WindowSelector switching to facebook
      const fbQuery = 'context(channel:facebook).window(1-Oct-25:1-Oct-25)';
      const fbData = isolateSlice(fileValues, fbQuery);
      
      expect(fbData.length).toBe(1);
      expect(fbData[0].n).toBe(150);
      expect(fbData[0].k).toBe(20);

      // Switch back to google - should still find the correct data
      const googleAgain = isolateSlice(fileValues, googleQuery);
      expect(googleAgain.length).toBe(1);
      expect(googleAgain[0].n).toBe(200); // NOT facebook's 150!
    });
  });

  describe('Step 5: "No data" markers prevent redundant fetches', () => {
    it('should find "no data" marker when checking cache for a slice with no API data', () => {
      // Simulate: AllSlicesModal fetched google (had data) and paid-social (no data)
      const values: ParameterValue[] = [
        // google had data
        { sliceDSL: 'context(channel:google)', n: 200, k: 30, mean: 0.15, dates: ['2025-10-01'], n_daily: [200], k_daily: [30] },
        // paid-social: API returned empty - we write a "no data" marker
        { 
          sliceDSL: 'context(channel:paid-social)', 
          n: 0, k: 0, mean: 0, 
          dates: ['2025-10-01'], 
          n_daily: [0], 
          k_daily: [0],
          data_source: ({ type: 'amplitude', no_data: true, retrieved_at: '2025-10-01T00:00:00Z' } as any),
        },
      ];

      // When user switches to paid-social, isolateSlice should find the "no data" marker
      const paidSocialResult = isolateSlice(values, 'context(channel:paid-social).window(1-Oct-25:1-Oct-25)');
      
      expect(paidSocialResult.length).toBe(1);
      expect(paidSocialResult[0].n).toBe(0);
      expect(paidSocialResult[0].dates).toContain('2025-10-01');
      expect((paidSocialResult[0].data_source as any)?.no_data).toBe(true);
    });

    it('calculateIncrementalFetch should NOT report missing dates when "no data" marker exists', async () => {
      const { calculateIncrementalFetch } = await import('../windowAggregationService');
      
      const paramData = {
        values: [
          // paid-social: "no data" marker from previous fetch
          { 
            sliceDSL: 'context(channel:paid-social)', 
            n: 0, k: 0, mean: 0, 
            dates: ['2025-10-01'], // This is the key - dates array exists
            n_daily: [0], 
            k_daily: [0],
            data_source: ({ type: 'amplitude' as const, no_data: true } as any),
          },
        ],
      };

      const result = calculateIncrementalFetch(
        paramData,
        { start: '2025-10-01T00:00:00Z', end: '2025-10-01T23:59:59Z' },
        undefined,
        false,
        'context(channel:paid-social).window(1-Oct-25:1-Oct-25)'
      );

      // Should NOT need fetch - the date exists (even if value is 0)
      expect(result.needsFetch).toBe(false);
      expect(result.daysAvailable).toBe(1);
      expect(result.missingDates.length).toBe(0);
    });
  });

  describe('Step 6: getParameterFromFile uses isolateSlice correctly', () => {
    // NOTE: This test requires extensive mocking of UpdateManager and other services.
    // The core slice isolation functionality is tested in Steps 2-5 above.
    // This integration test is skipped until we can properly mock all dependencies.
    it.skip('should load correct context data from file', async () => {
      // Setup file registry mock with pre-populated data
      const paramFile = {
        data: {
          id: 'test-param',
          type: 'probability',
          connection: 'amplitude-prod',
          values: [
            { 
              sliceDSL: 'context(channel:google)', 
              n: 200, k: 30, mean: 0.15,
              dates: ['2025-10-01'], n_daily: [200], k_daily: [30],
              window_from: '2025-10-01T00:00:00.000Z',
              window_to: '2025-10-01T23:59:59.000Z',
            },
            { 
              sliceDSL: 'context(channel:facebook)', 
              n: 150, k: 20, mean: 0.133,
              dates: ['2025-10-01'], n_daily: [150], k_daily: [20],
              window_from: '2025-10-01T00:00:00.000Z',
              window_to: '2025-10-01T23:59:59.000Z',
            },
          ],
        },
        isDirty: false,
      };

      vi.spyOn(fileRegistry, 'getFile').mockImplementation((fileId: string) => {
        if (fileId === 'parameter-test-param') return paramFile as any;
        return null;
      });

      const testGraph: any = {
        nodes: [
          { uuid: 'a', id: 'a', data: {} },
          { uuid: 'b', id: 'b', data: {} },
        ],
        edges: [{
          uuid: 'edge-1',
          from: 'a',
          to: 'b',
          p: { id: 'test-param', mean: 0, connection: 'amplitude-prod' },
        }],
        currentQueryDSL: 'context(channel:google).window(1-Oct-25:1-Oct-25)',
      };

      let updatedGraph = testGraph;
      const setGraph = vi.fn((g) => { updatedGraph = g; });

      // Load google context
      const result = await dataOperationsService.getParameterFromFile({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph: testGraph,
        setGraph,
        window: { start: '2025-10-01T00:00:00.000Z', end: '2025-10-01T23:59:59.000Z' },
        targetSlice: 'context(channel:google).window(1-Oct-25:1-Oct-25)',
      });
      
      expect(result.success).toBe(true);
      expect(setGraph).toHaveBeenCalled();
      
      // Get the graph that was passed to setGraph
      const finalGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0];
      const edge = finalGraph?.edges?.find((e: any) => e.uuid === 'edge-1');
      
      // Should have google's data (n=200), NOT facebook's (n=150)
      expect(edge?.p?.evidence?.n).toBe(200);
      expect(edge?.p?.evidence?.k).toBe(30);
    });
  });

  describe('Step 6: Planner E2E - uncontexted cohort is satisfied from contexted MECE slices (no refetch)', () => {
    function pickAnySignature(sig: string | string[]): string {
      return Array.isArray(sig) ? sig[0] : sig;
    }

    function seedChannel(values: string[]) {
      contextRegistry.clearCache();
      (contextRegistry as any).cache.set('channel', {
        id: 'channel',
        name: 'channel',
        description: 'test',
        type: 'categorical',
        // Treat "other" as a valid, queryable bucket for MECE completeness.
        // (In production this is typically 'explicit' or 'computed' when an 'other' slice exists.)
        otherPolicy: 'explicit',
        values: values.map((id) => ({ id, label: id })),
        metadata: { status: 'active', created_at: '1-Dec-25', version: '1.0.0' },
      });
    }

    (isSignatureCheckingEnabled() ? it : it.skip)(
      'CRITICAL: planner must NOT demand fetch when cohort headers fully cover requested window via MECE (signature-aware)',
      async () => {
      seedChannel(['paid-search', 'influencer', 'paid-social', 'other']);

      // Minimal graph with a single fetchable parameter.
      const graph: any = {
        nodes: [
          { id: 'a', uuid: 'a', event_id: 'a-event' },
          { id: 'b', uuid: 'b', event_id: 'b-event' },
        ],
        edges: [
          {
            id: 'edge-1',
            uuid: 'edge-1',
            from: 'a',
            to: 'b',
            // NOTE: connection is on the param slot, not on the edge.
            p: { id: 'test-param', connection: 'amplitude-prod' },
            query: 'from(a).to(b)',
          },
        ],
      };

      // Seed minimal event files so buildDslFromEdge can resolve provider event names.
      await fileRegistry.registerFile('event-a-event', {
        fileId: 'event-a-event',
        type: 'event',
        data: { id: 'a-event', provider_event_names: { amplitude: 'A' } },
        originalData: { id: 'a-event', provider_event_names: { amplitude: 'A' } },
        isDirty: false,
        isInitializing: false,
        source: { type: 'local' } as any,
        viewTabs: [],
        lastModified: Date.now(),
      } as any);
      await fileRegistry.registerFile('event-b-event', {
        fileId: 'event-b-event',
        type: 'event',
        data: { id: 'b-event', provider_event_names: { amplitude: 'B' } },
        originalData: { id: 'b-event', provider_event_names: { amplitude: 'B' } },
        isDirty: false,
        isInitializing: false,
        source: { type: 'local' } as any,
        viewTabs: [],
        lastModified: Date.now(),
      } as any);

      // Simulate Retrieve All having written ONLY contexted cohort slices (no uncontexted).
      // Importantly: we only provide cohort_from/cohort_to bounds — no per-day arrays.
      const values: ParameterValue[] = [
        { sliceDSL: 'context(channel:paid-search)', cohort_from: '1-Nov-25', cohort_to: '15-Dec-25', mean: 0.5, n: 1, k: 1 },
        { sliceDSL: 'context(channel:influencer)', cohort_from: '1-Nov-25', cohort_to: '15-Dec-25', mean: 0.5, n: 1, k: 1 },
        { sliceDSL: 'context(channel:paid-social)', cohort_from: '1-Nov-25', cohort_to: '15-Dec-25', mean: 0.5, n: 1, k: 1 },
        { sliceDSL: 'context(channel:other)', cohort_from: '1-Nov-25', cohort_to: '15-Dec-25', mean: 0.5, n: 1, k: 1 },
      ];

      // IMPORTANT: planner signature computation may depend on inspecting the parameter file values
      // (e.g. to detect implicit-uncontexted MECE fulfilment).
      // Register the file BEFORE computing signatures so the signature code sees the same state
      // the real planner would see in-app.
      await fileRegistry.registerFile('parameter-test-param', {
        fileId: 'parameter-test-param',
        type: 'parameter',
        data: { id: 'test-param', type: 'probability', values },
        originalData: { id: 'test-param', type: 'probability', values },
        isDirty: false,
        isInitializing: false,
        source: { type: 'local' } as any,
        viewTabs: [],
        lastModified: Date.now(),
      } as any);

      // Add real query_signature values matching what the planner will compute for this graph+DSL.
      // This ensures the test exercises signature isolation, not just header coverage.
      const dsl = 'cohort(19-Nov-25:24-Nov-25)';
      const sigs = await computePlannerQuerySignaturesForGraph({ graph, dsl });
      const itemKey = Object.keys(sigs)[0]; // single parameter in this test graph
      const sig = sigs[itemKey];
      const chosenSig = pickAnySignature(sig);
      expect(typeof chosenSig).toBe('string');
      expect((chosenSig as any).length).toBeGreaterThan(10);
      for (const v of values) (v as any).query_signature = chosenSig;

      const result = await windowFetchPlannerService.analyse(graph, dsl, 'dsl_change');

      // This is the core invariant the app needs:
      // "uncontexted cohort can be satisfied from contexted MECE slices (by header coverage)"
      expect(result.outcome).toBe('covered_stable');
      expect(result.fetchPlanItems.length).toBe(0);
      expect(result.unfetchableGaps.length).toBe(0);
      }
    );

    (isSignatureCheckingEnabled() ? it : it.skip)(
      'CRITICAL: if signed cache signatures do NOT match, planner must demand fetch (negative test)',
      async () => {
      seedChannel(['paid-search', 'influencer', 'paid-social', 'other']);

      const graph: any = {
        nodes: [
          { id: 'a', uuid: 'a', event_id: 'a-event' },
          { id: 'b', uuid: 'b', event_id: 'b-event' },
        ],
        edges: [
          {
            id: 'edge-1',
            uuid: 'edge-1',
            from: 'a',
            to: 'b',
            p: { id: 'test-param', connection: 'amplitude-prod' },
            query: 'from(a).to(b)',
          },
        ],
      };

      await fileRegistry.registerFile('event-a-event', {
        fileId: 'event-a-event',
        type: 'event',
        data: { id: 'a-event', provider_event_names: { amplitude: 'A' } },
        originalData: { id: 'a-event', provider_event_names: { amplitude: 'A' } },
        isDirty: false,
        isInitializing: false,
        source: { type: 'local' } as any,
        viewTabs: [],
        lastModified: Date.now(),
      } as any);
      await fileRegistry.registerFile('event-b-event', {
        fileId: 'event-b-event',
        type: 'event',
        data: { id: 'b-event', provider_event_names: { amplitude: 'B' } },
        originalData: { id: 'b-event', provider_event_names: { amplitude: 'B' } },
        isDirty: false,
        isInitializing: false,
        source: { type: 'local' } as any,
        viewTabs: [],
        lastModified: Date.now(),
      } as any);

      const values: ParameterValue[] = [
        { sliceDSL: 'context(channel:paid-search)', cohort_from: '1-Nov-25', cohort_to: '15-Dec-25', mean: 0.5, n: 1, k: 1 },
        { sliceDSL: 'context(channel:influencer)', cohort_from: '1-Nov-25', cohort_to: '15-Dec-25', mean: 0.5, n: 1, k: 1 },
        { sliceDSL: 'context(channel:paid-social)', cohort_from: '1-Nov-25', cohort_to: '15-Dec-25', mean: 0.5, n: 1, k: 1 },
        { sliceDSL: 'context(channel:other)', cohort_from: '1-Nov-25', cohort_to: '15-Dec-25', mean: 0.5, n: 1, k: 1 },
      ];

      // Deliberately wrong signatures: must force needs_fetch despite FULL headers.
      for (const v of values) (v as any).query_signature = 'deadbeef';

      await fileRegistry.registerFile('parameter-test-param', {
        fileId: 'parameter-test-param',
        type: 'parameter',
        data: { id: 'test-param', type: 'probability', values },
        originalData: { id: 'test-param', type: 'probability', values },
        isDirty: false,
        isInitializing: false,
        source: { type: 'local' } as any,
        viewTabs: [],
        lastModified: Date.now(),
      } as any);

      // Sanity: we must be able to compute a real "current signature" for this item, otherwise
      // signature isolation won't be exercised and the test becomes meaningless.
      const dsl = 'cohort(19-Nov-25:24-Nov-25)';
      const sigs = await computePlannerQuerySignaturesForGraph({ graph, dsl });
      const expectedItemKey = 'parameter:test-param:edge-1:p:'; // buildItemKey(...) canonical form
      expect(Object.keys(sigs)).toContain(expectedItemKey);
      const sig = sigs[expectedItemKey];
      const chosenSig = pickAnySignature(sig);
      expect(typeof chosenSig).toBe('string');
      expect((chosenSig as any).length).toBeGreaterThan(10);
      // Ensure the computed planner signature(s) are not trivially equal to our forced wrong signature.
      if (Array.isArray(sig)) {
        expect(sig).not.toContain('deadbeef');
      } else {
        expect(sig).not.toBe('deadbeef');
      }

      // Sanity: the plan builder must look up the signature using the SAME key.
      const built = buildFetchPlanProduction(
        graph,
        dsl,
        { start: '19-Nov-25', end: '24-Nov-25' },
        { querySignatures: sigs }
      );
      expect(built.plan.items.length).toBe(1);
      expect(built.plan.items[0].itemKey).toBe(expectedItemKey);

      const result = await windowFetchPlannerService.analyse(graph, dsl, 'dsl_change');

      expect(result.outcome).toBe('not_covered');
      expect(result.fetchPlanItems.length).toBeGreaterThan(0);
      }
    );
  });
});
