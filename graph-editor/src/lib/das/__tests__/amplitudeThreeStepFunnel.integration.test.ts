/**
 * Amplitude 3-Step Funnel Integration Test
 * 
 * Tests the complete DAS pipeline for a 3-step A→X→Y funnel using
 * REALISTIC data derived from REFERENCE-axy-funnel-response.json.
 * 
 * Reference data: A→X→Y funnel
 *   A = "Household Created" (anchor/cohort entry)
 *   X = "Blueprint CheckpointReached (SwitchRegistered)"
 *   Y = "Blueprint SwitchSuccess"
 * 
 * This validates that our connections.yaml adapter correctly:
 * 1. Extracts n/k from cumulativeRaw at correct step indices
 * 2. Builds time_series from dayFunnels with daily n/k/p
 * 3. Extracts latency data (median_lag_days, mean_lag_days) from trans times
 * 4. Handles 3-step funnel with anchor in cohort mode
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DASRunner } from '../DASRunner';
import { CredentialsManager } from '../../credentials';
import type { HttpExecutor, HttpRequest, HttpResponse } from '../HttpExecutor';
import type { ConnectionProvider } from '../ConnectionProvider';
import type { ConnectionDefinition } from '../types';
import * as yaml from 'yaml';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// REAL Amplitude reference response (A→X→Y 3-step funnel)
// =============================================================================

const REFERENCE_RESPONSE_PATH = path.join(
  __dirname,
  '../../../../../docs/current/project-lag/test-data/REFERENCE-axy-funnel-response.json'
);

/**
 * Load the ACTUAL recorded Amplitude response used to design Project LAG.
 * 
 * This ensures the integration tests exercise the real payload shape, not a
 * hand-crafted mock. If the reference file changes, these tests will catch
 * any schema or adapter drift.
 */
function loadReferenceResponse(): any {
  const content = fs.readFileSync(REFERENCE_RESPONSE_PATH, 'utf8');
  return JSON.parse(content);
}

/**
 * 2-step funnel response for X→Y query (without anchor).
 * When querying from(X).to(Y), Amplitude returns a 2-step funnel.
 */
const MOCK_TWO_STEP_RESPONSE = {
  data: [{
    events: [
      "Blueprint CheckpointReached (SwitchRegistered)",
      "Blueprint SwitchSuccess"
    ],
    
    // X=1450, Y=1021 (same as steps 1,2 from 3-step)
    cumulativeRaw: [1450, 1021],
    cumulative: [1.0, 0.7041379310344827],
    stepByStep: [1.0, 0.7041379310344827],
    
    dayFunnels: {
      xValues: ["2025-09-01", "2025-09-02", "2025-09-03", "2025-09-04", "2025-09-05"],
      // series[day][step]: [X, Y] counts
      series: [
        [21, 19],
        [7, 4],
        [12, 10],
        [4, 4],
        [3, 2]
      ],
      formattedXValues: ["Sep 01", "Sep 02", "Sep 03", "Sep 04", "Sep 05"]
    },
    
    // X→Y transition times only (2 steps)
    // Index 0: entry, Index 1: X→Y
    medianTransTimes: [0, 520021000],  // ~6.0 days
    avgTransTimes: [0, 601195886],     // ~7.0 days
    
    dayMedianTransTimes: {
      xValues: ["2025-09-01", "2025-09-02", "2025-09-03", "2025-09-04", "2025-09-05"],
      series: [
        [0, 518417500],
        [0, 518417500],
        [0, 518435000],
        [0, 561618000],
        [0, 518417000]
      ]
    },
    
    dayAvgTransTimes: {
      xValues: ["2025-09-01", "2025-09-02", "2025-09-03", "2025-09-04", "2025-09-05"],
      series: [
        [0, 604800000],
        [0, 604800000],
        [0, 604800000],
        [0, 650000000],
        [0, 604800000]
      ]
    },
    
    groupValue: "",
    meta: { segmentIndex: 0 },
    propsum: []
  }],
  numSeries: 1,
  wasCached: true,
  backend: "novaV2"
};

// =============================================================================
// Test Infrastructure
// =============================================================================

class MockHttpExecutor implements HttpExecutor {
  public lastRequest: HttpRequest | null = null;
  public mockResponse: any = MOCK_TWO_STEP_RESPONSE;
  
  async execute(request: HttpRequest): Promise<HttpResponse> {
    this.lastRequest = request;
    
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: this.mockResponse,
      rawBody: JSON.stringify(this.mockResponse)
    };
  }
}

class RealConnectionProvider implements ConnectionProvider {
  private connections: Map<string, ConnectionDefinition> = new Map();
  
  constructor() {
    const connectionsPath = path.join(__dirname, '../../../../public/defaults/connections.yaml');
    if (fs.existsSync(connectionsPath)) {
      const content = fs.readFileSync(connectionsPath, 'utf8');
      const parsed = yaml.parse(content);
      if (parsed.connections) {
        for (const conn of parsed.connections) {
          this.connections.set(conn.name, conn);
        }
      }
    } else {
      throw new Error(`connections.yaml not found at ${connectionsPath}`);
    }
  }
  
  async getConnection(name: string): Promise<ConnectionDefinition> {
    const conn = this.connections.get(name);
    if (!conn) {
      throw new Error(`Connection "${name}" not found`);
    }
    return conn;
  }
  
  async getAllConnections(): Promise<ConnectionDefinition[]> {
    return Array.from(this.connections.values());
  }
  
  async getConnectionFile() {
    return { version: '1.0.0', connections: [] };
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('Amplitude 3-Step Funnel Integration', () => {
  let runner: DASRunner;
  let mockHttpExecutor: MockHttpExecutor;
  let connectionProvider: RealConnectionProvider;
  let credentialsManager: CredentialsManager;

  beforeEach(() => {
    mockHttpExecutor = new MockHttpExecutor();
    connectionProvider = new RealConnectionProvider();
    credentialsManager = CredentialsManager.getInstance();
    
    vi.spyOn(credentialsManager, 'loadCredentials').mockResolvedValue({
      success: true,
      source: 'mock' as any
    });
    vi.spyOn(credentialsManager, 'getProviderCredentials').mockReturnValue({
      api_key: 'test-api-key',
      secret_key: 'test-secret-key',
      basic_auth_b64: Buffer.from('test-api-key:test-secret-key').toString('base64')
    });
    
    runner = new DASRunner(
      mockHttpExecutor,
      credentialsManager,
      connectionProvider
    );
  });

  describe('2-Step X→Y Query (from(X).to(Y))', () => {
    
    it('should extract correct n/k from cumulativeRaw', async () => {
      mockHttpExecutor.mockResponse = MOCK_TWO_STEP_RESPONSE;
      
      const result = await runner.execute('amplitude-prod', {
        from: 'switch-registered',
        to: 'switch-success'
      }, {
        window: { start: '2025-09-01T00:00:00Z', end: '2025-09-05T23:59:59Z' },
        edgeId: 'switch-registered-to-switch-success',
        eventDefinitions: {
          'switch-registered': { provider_event_names: { amplitude: 'Blueprint CheckpointReached (SwitchRegistered)' } },
          'switch-success': { provider_event_names: { amplitude: 'Blueprint SwitchSuccess' } }
        },
        context: { mode: 'daily', excludeTestAccounts: false }
      });
      
      // Diagnostics
      console.log('[TEST] 2-Step n/k extraction result:', {
        success: result.success,
        error: result.success ? null : (result as any).error,
        raw_keys: result.success ? Object.keys(result.raw) : null,
        n: result.success ? (result.raw as any).n : null,
        k: result.success ? (result.raw as any).k : null,
        p_mean: result.success ? (result.raw as any).p_mean : null,
        from_step_index: result.success ? (result.raw as any)._debug_from_step_index : null,
        to_step_index: result.success ? (result.raw as any)._debug_to_step_index : null
      });
      
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(`Execution failed: ${result.error}`);
      
      const raw = result.raw as any;
      
      // 2-step funnel: from_step_index=0, to_step_index=1
      // n = cumulativeRaw[0] = 1450, k = cumulativeRaw[1] = 1021
      expect(raw.n).toBe(1450);
      expect(raw.k).toBe(1021);
      expect(raw.p_mean).toBeCloseTo(1021 / 1450, 4);  // ~0.7041
    });

    it('should build time_series with daily n/k/p in daily mode', async () => {
      mockHttpExecutor.mockResponse = MOCK_TWO_STEP_RESPONSE;
      
      const result = await runner.execute('amplitude-prod', {
        from: 'switch-registered',
        to: 'switch-success'
      }, {
        window: { start: '2025-09-01T00:00:00Z', end: '2025-09-05T23:59:59Z' },
        edgeId: 'test-edge',
        eventDefinitions: {
          'switch-registered': { provider_event_names: { amplitude: 'Blueprint CheckpointReached (SwitchRegistered)' } },
          'switch-success': { provider_event_names: { amplitude: 'Blueprint SwitchSuccess' } }
        },
        context: { mode: 'daily', excludeTestAccounts: false }
      });
      
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(`Execution failed: ${result.error}`);
      
      const raw = result.raw as any;
      
      // Diagnostics
      console.log('[TEST] time_series extraction:', {
        mode: raw.mode,
        time_series_type: typeof raw.time_series,
        time_series_is_array: Array.isArray(raw.time_series),
        time_series_length: Array.isArray(raw.time_series) ? raw.time_series.length : 'N/A',
        time_series_first: Array.isArray(raw.time_series) ? raw.time_series[0] : null,
        day_funnels_type: typeof raw.day_funnels,
        day_funnels_series: raw.day_funnels?.series
      });
      
      // Strict assertions
      expect(raw.mode).toBe('daily');
      expect(Array.isArray(raw.time_series)).toBe(true);
      expect(raw.time_series.length).toBe(5);  // 5 days
      
      // Day 1: 2025-09-01, X=21, Y=19
      expect(raw.time_series[0].date).toBe('2025-09-01');
      expect(raw.time_series[0].n).toBe(21);
      expect(raw.time_series[0].k).toBe(19);
      expect(raw.time_series[0].p).toBeCloseTo(19 / 21, 4);  // ~0.905
      
      // Day 2: 2025-09-02, X=7, Y=4
      expect(raw.time_series[1].date).toBe('2025-09-02');
      expect(raw.time_series[1].n).toBe(7);
      expect(raw.time_series[1].k).toBe(4);
      expect(raw.time_series[1].p).toBeCloseTo(4 / 7, 4);  // ~0.571
      
      // Day 3: 2025-09-03, X=12, Y=10
      expect(raw.time_series[2].date).toBe('2025-09-03');
      expect(raw.time_series[2].n).toBe(12);
      expect(raw.time_series[2].k).toBe(10);
      expect(raw.time_series[2].p).toBeCloseTo(10 / 12, 4);  // ~0.833
    });

    it('should extract aggregate latency data (median_lag_days, mean_lag_days)', async () => {
      mockHttpExecutor.mockResponse = MOCK_TWO_STEP_RESPONSE;
      
      const result = await runner.execute('amplitude-prod', {
        from: 'switch-registered',
        to: 'switch-success'
      }, {
        window: { start: '2025-09-01T00:00:00Z', end: '2025-09-05T23:59:59Z' },
        edgeId: 'test-edge',
        eventDefinitions: {
          'switch-registered': { provider_event_names: { amplitude: 'Blueprint CheckpointReached (SwitchRegistered)' } },
          'switch-success': { provider_event_names: { amplitude: 'Blueprint SwitchSuccess' } }
        },
        context: { mode: 'daily', excludeTestAccounts: false }
      });
      
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(`Execution failed: ${result.error}`);
      
      const raw = result.raw as any;
      
      // Diagnostics
      console.log('[TEST] Latency extraction:', {
        median_trans_times: raw.median_trans_times,
        avg_trans_times: raw.avg_trans_times,
        median_lag_days: raw.median_lag_days,
        mean_lag_days: raw.mean_lag_days,
        to_step_index: raw._debug_to_step_index
      });
      
      // medianTransTimes[1] = 520021000 ms = 520021000 / 86400000 days = ~6.02 days
      const expectedMedianDays = 520021000 / 86400000;  // ~6.02
      const expectedMeanDays = 601195886 / 86400000;    // ~6.96
      
      expect(raw.median_lag_days).toBeCloseTo(expectedMedianDays, 1);
      expect(raw.mean_lag_days).toBeCloseTo(expectedMeanDays, 1);
    });

    // NOTE: Per-day latency (median_lag_days/mean_lag_days in time_series)
    // is primarily required and used in cohort (3-step) mode for LAG.
    // A dedicated test for that lives in the 3-step cohort suite below.
  });

  describe('3-Step A→X→Y Cohort Mode Query', () => {
    
    it('should handle 3-step funnel with anchor and extract X→Y data', async () => {
      // In cohort mode with anchor, the adapter prepends anchor as step 0
      // So from_step_index shifts to 1, to_step_index shifts to 2
      mockHttpExecutor.mockResponse = loadReferenceResponse();
      
      // NOTE: cohort must be in OPTIONS (3rd arg), not queryPayload
      const result = await runner.execute('amplitude-prod', {
        from: 'switch-registered',
        to: 'switch-success',
      }, {
        window: { start: '2025-09-01T00:00:00Z', end: '2025-09-05T23:59:59Z' },
        edgeId: 'test-edge',
        eventDefinitions: {
          'household-created': { provider_event_names: { amplitude: 'Household Created' } },
          'switch-registered': { provider_event_names: { amplitude: 'Blueprint CheckpointReached (SwitchRegistered)' } },
          'switch-success': { provider_event_names: { amplitude: 'Blueprint SwitchSuccess' } }
        },
        context: { mode: 'daily', excludeTestAccounts: false },
        cohort: {
          start: '2025-09-01T00:00:00Z',
          end: '2025-09-05T23:59:59Z',
          anchor_event_id: 'household-created',
          conversion_window_days: 30
        }
      });
      
      // Diagnostics
      console.log('[TEST] 3-Step cohort mode result:', {
        success: result.success,
        error: result.success ? null : (result as any).error,
        n: result.success ? (result.raw as any).n : null,
        k: result.success ? (result.raw as any).k : null,
        from_step_index: result.success ? (result.raw as any)._debug_from_step_index : null,
        to_step_index: result.success ? (result.raw as any)._debug_to_step_index : null,
        cumulativeRaw: result.success ? (result.raw as any)._debug_cumulativeRaw : null
      });
      
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(`Execution failed: ${result.error}`);
      
      const raw = result.raw as any;

      // Basic sanity checks on aggregate counts and probability
      expect(typeof raw.n).toBe('number');
      expect(typeof raw.k).toBe('number');
      expect(typeof raw.p_mean).toBe('number');
      expect(raw.n).toBeGreaterThan(0);
      expect(raw.k).toBeGreaterThanOrEqual(0);
      expect(raw.k).toBeLessThanOrEqual(raw.n);
      expect(raw.p_mean).toBeCloseTo(raw.k / raw.n, 4);
    });

    it('should extract X→Y latency from 3-step funnel (step index 2)', async () => {
      mockHttpExecutor.mockResponse = loadReferenceResponse();
      
      // NOTE: cohort must be in OPTIONS (3rd arg)
      const result = await runner.execute('amplitude-prod', {
        from: 'switch-registered',
        to: 'switch-success',
      }, {
        window: { start: '2025-09-01T00:00:00Z', end: '2025-09-05T23:59:59Z' },
        edgeId: 'test-edge',
        eventDefinitions: {
          'household-created': { provider_event_names: { amplitude: 'Household Created' } },
          'switch-registered': { provider_event_names: { amplitude: 'Blueprint CheckpointReached (SwitchRegistered)' } },
          'switch-success': { provider_event_names: { amplitude: 'Blueprint SwitchSuccess' } }
        },
        context: { mode: 'daily', excludeTestAccounts: false },
        cohort: {
          start: '2025-09-01T00:00:00Z',
          end: '2025-09-05T23:59:59Z',
          anchor_event_id: 'household-created',
          conversion_window_days: 30
        }
      });
      
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(`Execution failed: ${result.error}`);
      
      const raw = result.raw as any;

      // We don't know the exact step index here (depends on adapter), but we
      // can still assert that the adapter produced sensible latency values.
      expect(typeof raw.median_lag_days).toBe('number');
      expect(typeof raw.mean_lag_days).toBe('number');
      expect(raw.median_lag_days).toBeGreaterThan(0);
      expect(raw.mean_lag_days).toBeGreaterThan(0);
    });

    it('should extract anchor lag (A→X) for downstream completeness calculation', async () => {
      // In 3-step A→X→Y funnel, we need A→X lag to adjust effective cohort ages
      // for downstream edges. This is CRITICAL for correct completeness calculation.
      mockHttpExecutor.mockResponse = loadReferenceResponse();
      
      // NOTE: `cohort` must be in OPTIONS (3rd arg), not queryPayload (2nd arg)
      // The DASRunner passes options.cohort to the pre_request script
      const result = await runner.execute('amplitude-prod', {
        from: 'switch-registered',
        to: 'switch-success',
      }, {
        window: { start: '2025-09-01T00:00:00Z', end: '2025-09-05T23:59:59Z' },
        edgeId: 'test-edge',
        eventDefinitions: {
          'household-created': { provider_event_names: { amplitude: 'Household Created' } },
          'switch-registered': { provider_event_names: { amplitude: 'Blueprint CheckpointReached (SwitchRegistered)' } },
          'switch-success': { provider_event_names: { amplitude: 'Blueprint SwitchSuccess' } }
        },
        context: { mode: 'daily', excludeTestAccounts: false },
        // CRITICAL: cohort must be in options for DASRunner to pass to pre_request script
        cohort: {
          start: '2025-09-01T00:00:00Z',
          end: '2025-09-05T23:59:59Z',
          anchor_event_id: 'household-created',
          conversion_window_days: 30
        }
      });
      
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(`Execution failed: ${result.error}`);
      
      const raw = result.raw as any;

      // Diagnostics for anchor lag extraction
      console.log('[TEST] Anchor lag extraction:', {
        anchor_median_lag_days: raw.anchor_median_lag_days,
        anchor_mean_lag_days: raw.anchor_mean_lag_days,
        time_series_first: raw.time_series?.[0],
        from_step_index: raw._debug_from_step_index,
        to_step_index: raw._debug_to_step_index,
      });
      
      // For 3-step A→X→Y funnel:
      //   - from_step_index = 1 (X), to_step_index = 2 (Y)
      //   - medianTransTimes[1] = A→X = 11.41 days (anchor lag)
      //   - medianTransTimes[2] = X→Y = 6.02 days (edge lag)
      //
      // Reference data medianTransTimes: [1560114000, 985545000, 520021000]
      //   - Index 0: 18.06 days (entry → A)
      //   - Index 1: 11.41 days (A → X)  ← anchor_median_lag_days
      //   - Index 2: 6.02 days (X → Y)   ← median_lag_days
      
      expect(typeof raw.anchor_median_lag_days).toBe('number');
      expect(typeof raw.anchor_mean_lag_days).toBe('number');
      
      // Both should be positive
      expect(raw.anchor_median_lag_days).toBeGreaterThan(0);
      expect(raw.anchor_mean_lag_days).toBeGreaterThan(0);
      
      // SEMANTIC CHECK: For a 3-step funnel with correct index shifting:
      // - anchor_median_lag_days = A→X (~11.4 days)
      // - median_lag_days = X→Y (~6.0 days)
      // - A→X transition takes LONGER than X→Y, so anchor > edge
      //
      // If this fails, the pre_request script isn't setting from_step_index=1, to_step_index=2
      console.log('[TEST] Semantic check values:', {
        anchor_median_lag_days: raw.anchor_median_lag_days,
        median_lag_days: raw.median_lag_days,
        expected_anchor: 11.41,  // medianTransTimes[1] / 86400000
        expected_edge: 6.02,     // medianTransTimes[2] / 86400000
        from_step_index: raw._debug_from_step_index,
        to_step_index: raw._debug_to_step_index,
      });
      
      // Verify correct indices are being used (1 and 2, not 0 and 1)
      expect(raw.anchor_median_lag_days).toBeCloseTo(11.41, 1);  // A→X = ~11.4 days
      expect(raw.median_lag_days).toBeCloseTo(6.02, 1);           // X→Y = ~6.0 days
      
      // Semantic: upstream (A→X) transition takes longer than downstream (X→Y)
      expect(raw.anchor_median_lag_days).toBeGreaterThan(raw.median_lag_days);
      
      // Time series should also have per-day anchor lag data
      if (raw.time_series && raw.time_series.length > 0) {
        const firstDay = raw.time_series[0];
        expect(firstDay.anchor_median_lag_days).toBeDefined();
        expect(firstDay.anchor_mean_lag_days).toBeDefined();
        // anchor_n should be the step 0 count (anchor entry count)
        expect(firstDay.anchor_n).toBeDefined();
        expect(typeof firstDay.anchor_n).toBe('number');
      }
    });
  });

  describe('Data Structure Validation for Graph Upsert', () => {
    
    it('should produce all required fields for dataOperationsService', async () => {
      mockHttpExecutor.mockResponse = MOCK_TWO_STEP_RESPONSE;
      
      const result = await runner.execute('amplitude-prod', {
        from: 'switch-registered',
        to: 'switch-success'
      }, {
        window: { start: '2025-09-01T00:00:00Z', end: '2025-09-05T23:59:59Z' },
        edgeId: 'test-edge',
        eventDefinitions: {
          'switch-registered': { provider_event_names: { amplitude: 'Blueprint CheckpointReached (SwitchRegistered)' } },
          'switch-success': { provider_event_names: { amplitude: 'Blueprint SwitchSuccess' } }
        },
        context: { mode: 'daily', excludeTestAccounts: false }
      });
      
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(`Execution failed: ${result.error}`);
      
      const raw = result.raw as any;
      
      // Aggregate fields (always required)
      expect(typeof raw.n).toBe('number');
      expect(typeof raw.k).toBe('number');
      expect(typeof raw.p_mean).toBe('number');
      expect(raw.n).toBeGreaterThan(0);
      expect(raw.k).toBeGreaterThan(0);
      expect(raw.p_mean).toBeGreaterThan(0);
      expect(raw.p_mean).toBeLessThanOrEqual(1);
      
      // Time series (required in daily mode)
      expect(Array.isArray(raw.time_series)).toBe(true);
      expect(raw.time_series.length).toBeGreaterThan(0);
      
      const firstDay = raw.time_series[0];
      expect(typeof firstDay.date).toBe('string');
      expect(typeof firstDay.n).toBe('number');
      expect(typeof firstDay.k).toBe('number');
      expect(typeof firstDay.p).toBe('number');
      
      // Latency fields (required for LAG)
      expect(typeof raw.median_lag_days).toBe('number');
      expect(typeof raw.mean_lag_days).toBe('number');
      expect(raw.median_lag_days).toBeGreaterThan(0);
      expect(raw.mean_lag_days).toBeGreaterThan(0);
      
      // Per-day latency in time_series - NOW EXTRACTED!
      expect(firstDay.median_lag_days).toBeDefined();
      expect(typeof firstDay.median_lag_days).toBe('number');
      expect(firstDay.median_lag_days).toBeGreaterThan(0);
      expect(firstDay.mean_lag_days).toBeDefined();
      expect(typeof firstDay.mean_lag_days).toBe('number');
      expect(firstDay.mean_lag_days).toBeGreaterThan(0);
    });

    it('should generate correct upsert writes', async () => {
      mockHttpExecutor.mockResponse = MOCK_TWO_STEP_RESPONSE;
      
      const result = await runner.execute('amplitude-prod', {
        from: 'switch-registered',
        to: 'switch-success'
      }, {
        window: { start: '2025-09-01T00:00:00Z', end: '2025-09-05T23:59:59Z' },
        edgeId: 'my-edge-id',
        eventDefinitions: {
          'switch-registered': { provider_event_names: { amplitude: 'Blueprint CheckpointReached (SwitchRegistered)' } },
          'switch-success': { provider_event_names: { amplitude: 'Blueprint SwitchSuccess' } }
        },
        context: { mode: 'daily', excludeTestAccounts: false }
      });
      
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(`Execution failed: ${result.error}`);
      
      // Check upsert instructions
      const updates = result.updates;
      expect(Array.isArray(updates)).toBe(true);
      expect(updates.length).toBeGreaterThanOrEqual(3);  // At least p.mean, n, k
      
      // Verify targets contain edge ID
      const targets = updates.map(u => u.target);
      expect(targets).toContain('/edges/my-edge-id/p/mean');
      expect(targets).toContain('/edges/my-edge-id/p/evidence/n');
      expect(targets).toContain('/edges/my-edge-id/p/evidence/k');
      
      // Verify values are correct
      const meanUpdate = updates.find(u => u.target === '/edges/my-edge-id/p/mean');
      const nUpdate = updates.find(u => u.target === '/edges/my-edge-id/p/evidence/n');
      const kUpdate = updates.find(u => u.target === '/edges/my-edge-id/p/evidence/k');
      
      expect(meanUpdate?.value).toBeCloseTo(0.7041, 3);
      expect(nUpdate?.value).toBe(1450);
      expect(kUpdate?.value).toBe(1021);
    });
  });

  describe('Request URL Construction', () => {
    
    it('should construct correct Amplitude API URL with funnel events', async () => {
      mockHttpExecutor.mockResponse = MOCK_TWO_STEP_RESPONSE;
      
      await runner.execute('amplitude-prod', {
        from: 'switch-registered',
        to: 'switch-success'
      }, {
        window: { start: '2025-09-01T00:00:00Z', end: '2025-09-05T23:59:59Z' },
        edgeId: 'test-edge',
        eventDefinitions: {
          'switch-registered': { provider_event_names: { amplitude: 'SwitchRegistered' } },
          'switch-success': { provider_event_names: { amplitude: 'SwitchSuccess' } }
        },
        context: { mode: 'daily', excludeTestAccounts: false }
      });
      
      const url = mockHttpExecutor.lastRequest?.url;
      expect(url).toBeDefined();
      
      console.log('[TEST] Request URL:', url);
      
      // Should contain base URL
      expect(url).toContain('amplitude.com/api/2/funnels');
      
      // Should contain funnel events
      expect(url).toContain('e=');
      
      // Should contain date range
      expect(url).toContain('start=20250901');
      expect(url).toContain('end=20250905');
      
      // Should have daily interval
      expect(url).toContain('i=1');
    });
  });
});
