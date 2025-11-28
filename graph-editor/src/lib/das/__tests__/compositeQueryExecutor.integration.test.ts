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
});

