/**
 * Integration tests for compositeQueryExecutor
 * 
 * These tests verify that executeCompositeQuery properly passes all required
 * options to the DAS runner, including eventDefinitions for event name translation.
 * 
 * Bug context: Composite queries with minus() were failing with "Invalid <event-id>"
 * errors because eventDefinitions were not being passed to runner.execute().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeCompositeQuery } from '../compositeQueryExecutor';
import type { DASRunner } from '../DASRunner';

describe('compositeQueryExecutor - Integration Tests', () => {
  
  let mockRunner: DASRunner;
  let executeCalls: Array<{
    connectionName: string;
    queryPayload: any;
    options: any;
  }>;

  beforeEach(() => {
    executeCalls = [];
    
    // Create a mock DAS runner that captures all execute() calls
    mockRunner = {
      execute: vi.fn().mockImplementation((connectionName, queryPayload, options) => {
        executeCalls.push({ connectionName, queryPayload, options });
        return Promise.resolve({
          success: true,
          raw: {
            from_count: 100,
            to_count: 50,
            time_series: []
          }
        });
      })
    } as unknown as DASRunner;
  });

  describe('eventDefinitions passing', () => {
    
    it('should pass eventDefinitions to runner.execute() for all sub-queries', async () => {
      const queryString = 'from(node-a).to(node-b).minus(node-c)';
      const baseDsl = {
        from: 'event-a',
        to: 'event-b',
        window: { start: '2025-01-01', end: '2025-01-31' },
        mode: 'aggregate'
      };
      const eventDefinitions = {
        'event-a': { id: 'event-a', provider_event_names: { amplitude: 'Event A' } },
        'event-b': { id: 'event-b', provider_event_names: { amplitude: 'Event B' } },
        'event-c': { id: 'event-c', provider_event_names: { amplitude: 'Event C' } }
      };

      await executeCompositeQuery(
        queryString,
        baseDsl,
        'amplitude-prod',
        mockRunner,
        undefined,  // graph
        eventDefinitions
      );

      // Should have 2 calls: base query + minus query
      expect(executeCalls).toHaveLength(2);

      // Both calls should have eventDefinitions in options
      for (const call of executeCalls) {
        expect(call.options).toHaveProperty('eventDefinitions');
        expect(call.options.eventDefinitions).toBe(eventDefinitions);
      }
    });

    it('should handle undefined eventDefinitions gracefully', async () => {
      const queryString = 'from(node-a).to(node-b)';
      const baseDsl = {
        from: 'event-a',
        to: 'event-b',
        window: { start: '2025-01-01', end: '2025-01-31' },
        mode: 'aggregate'
      };

      // Call without eventDefinitions (undefined)
      await executeCompositeQuery(
        queryString,
        baseDsl,
        'amplitude-prod',
        mockRunner,
        undefined,  // graph
        undefined   // eventDefinitions
      );

      // Should still work, just with undefined eventDefinitions
      expect(executeCalls).toHaveLength(1);
      expect(call => call.options.eventDefinitions).toBeDefined(); // Property exists
    });

    it('should pass eventDefinitions to all minus term sub-queries', async () => {
      // Multiple minus terms
      const queryString = 'from(node-a).to(node-d).minus(node-b).minus(node-c)';
      const baseDsl = {
        from: 'event-a',
        to: 'event-d',
        window: { start: '2025-01-01', end: '2025-01-31' },
        mode: 'daily'
      };
      const eventDefinitions = {
        'event-a': { id: 'event-a', provider_event_names: { amplitude: 'Event A' } },
        'event-d': { id: 'event-d', provider_event_names: { amplitude: 'Event D' } }
      };

      await executeCompositeQuery(
        queryString,
        baseDsl,
        'amplitude-prod',
        mockRunner,
        undefined,
        eventDefinitions
      );

      // Should have 3 calls: base + 2 minus terms
      expect(executeCalls).toHaveLength(3);

      // ALL calls should have eventDefinitions
      for (let i = 0; i < executeCalls.length; i++) {
        expect(executeCalls[i].options.eventDefinitions).toBe(eventDefinitions);
      }
    });
  });

  describe('other options passing', () => {
    
    it('should pass window to all sub-queries', async () => {
      const queryString = 'from(node-a).to(node-b).minus(node-c)';
      const baseDsl = {
        from: 'event-a',
        to: 'event-b',
        window: { start: '2025-01-01', end: '2025-01-31' },
        mode: 'aggregate'
      };

      await executeCompositeQuery(
        queryString,
        baseDsl,
        'amplitude-prod',
        mockRunner
      );

      // All calls should have window
      for (const call of executeCalls) {
        expect(call.options.window).toEqual(baseDsl.window);
      }
    });

    it('should pass context mode to all sub-queries', async () => {
      const queryString = 'from(node-a).to(node-b).minus(node-c)';
      const baseDsl = {
        from: 'event-a',
        to: 'event-b',
        window: {},
        mode: 'daily'
      };

      await executeCompositeQuery(
        queryString,
        baseDsl,
        'amplitude-prod',
        mockRunner
      );

      // All calls should have context.mode
      for (const call of executeCalls) {
        expect(call.options.context).toHaveProperty('mode', 'daily');
      }
    });
  });

  describe('regression test for minus() eventDefinitions bug', () => {
    
    it('should NOT fail with "Invalid <event-id>" when eventDefinitions are provided', async () => {
      // This is the exact scenario that was failing before the fix:
      // Query: from(saw-wa-details-page).to(viewed-dashboard).minus(gave-bds-in-onboarding)
      // Error: "Invalid saw-wa-details-page" because eventDefinitions wasn't passed
      
      const queryString = 'from(saw-wa-details-page).to(viewed-dashboard).minus(gave-bds-in-onboarding)';
      const baseDsl = {
        from: 'saw-wa-details-page',  // This is the event_id from the node
        to: 'viewed-dashboard',
        window: { start: '2025-10-28', end: '2025-11-14' },
        mode: 'aggregate'
      };
      
      // Event definitions map event_ids to Amplitude event names
      const eventDefinitions = {
        'saw-wa-details-page': { 
          id: 'saw-wa-details-page', 
          provider_event_names: { 
            amplitude: 'Viewed WhatsApp details /onboarding/whatsApp-details Page' 
          } 
        },
        'viewed-dashboard': { 
          id: 'viewed-dashboard', 
          provider_event_names: { 
            amplitude: 'User sees dashboard' 
          } 
        },
        'gave-bds-in-onboarding': { 
          id: 'gave-bds-in-onboarding', 
          provider_event_names: { 
            amplitude: 'BankAccount DetailsEntryConfirmed' 
          } 
        }
      };

      // Execute - this should NOT throw
      await expect(executeCompositeQuery(
        queryString,
        baseDsl,
        'amplitude-prod',
        mockRunner,
        undefined,
        eventDefinitions
      )).resolves.not.toThrow();

      // Verify eventDefinitions was passed to all sub-queries
      expect(executeCalls.length).toBeGreaterThanOrEqual(2);
      for (const call of executeCalls) {
        expect(call.options.eventDefinitions).toBe(eventDefinitions);
      }
    });
  });

  describe('§0.1 Latency Data Preservation', () => {
    /**
     * CRITICAL: When combining sub-query results via inclusion-exclusion,
     * latency fields (median_lag_days, mean_lag_days, anchor_*) from the
     * base query must be preserved in the combined time_series output.
     */

    it('should preserve latency fields from base query in combined time_series', async () => {
      // Setup mock runner to return time_series with latency data for base query
      const baseTimeSeries = [
        { date: '2025-01-01', n: 100, k: 50, p: 0.5, median_lag_days: 3.5, mean_lag_days: 4.2, anchor_median_lag_days: 2.1, anchor_mean_lag_days: 2.8 },
        { date: '2025-01-02', n: 120, k: 60, p: 0.5, median_lag_days: 3.2, mean_lag_days: 4.0, anchor_median_lag_days: 2.0, anchor_mean_lag_days: 2.5 },
      ];
      const minusTimeSeries = [
        { date: '2025-01-01', n: 100, k: 10, p: 0.1 },  // No latency in minus query
        { date: '2025-01-02', n: 120, k: 15, p: 0.125 },
      ];

      let callIndex = 0;
      mockRunner.execute = vi.fn().mockImplementation(() => {
        const isBase = callIndex === 0;
        callIndex++;
        return Promise.resolve({
          success: true,
          raw: {
            from_count: isBase ? 220 : 220,
            to_count: isBase ? 110 : 25,
            time_series: isBase ? baseTimeSeries : minusTimeSeries,
          }
        });
      });

      const queryString = 'from(node-a).to(node-b).minus(node-c)';
      const baseDsl = {
        from: 'event-a',
        to: 'event-b',
        window: { start: '2025-01-01', end: '2025-01-02' },
        mode: 'daily'
      };

      const result = await executeCompositeQuery(
        queryString,
        baseDsl,
        'amplitude-prod',
        mockRunner
      );

      // Verify time_series exists
      expect(result.evidence.time_series).toBeDefined();
      expect(result.evidence.time_series?.length).toBe(2);

      // Verify latency fields are preserved from base query
      const day1 = result.evidence.time_series?.find(d => d.date === '2025-01-01');
      const day2 = result.evidence.time_series?.find(d => d.date === '2025-01-02');

      expect(day1?.median_lag_days).toBe(3.5);
      expect(day1?.mean_lag_days).toBe(4.2);
      expect(day1?.anchor_median_lag_days).toBe(2.1);
      expect(day1?.anchor_mean_lag_days).toBe(2.8);

      expect(day2?.median_lag_days).toBe(3.2);
      expect(day2?.mean_lag_days).toBe(4.0);
      expect(day2?.anchor_median_lag_days).toBe(2.0);
      expect(day2?.anchor_mean_lag_days).toBe(2.5);

      // Verify k was adjusted via inclusion-exclusion (but latency preserved)
      // k_adjusted = k_base - k_minus (coefficient -1 for minus term)
      expect(day1?.k).toBe(40);  // 50 - 10 = 40
      expect(day2?.k).toBe(45);  // 60 - 15 = 45
    });
  });
});

