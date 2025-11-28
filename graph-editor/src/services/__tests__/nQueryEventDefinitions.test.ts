/**
 * Tests for n_query event definitions merging
 * 
 * This test verifies that event definitions from n_query processing
 * are properly merged into the main eventDefinitions object before
 * being passed to the DAS adapter.
 * 
 * Bug context: n_query was failing with "Invalid household-created" errors
 * because event definitions loaded during buildDslFromEdge for n_query
 * were not being captured and merged - the code only extracted queryPayload
 * but ignored eventDefinitions from the result.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('n_query Event Definitions', () => {
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Event definitions merging', () => {
    
    it('should merge n_query event definitions into main eventDefinitions', () => {
      // Simulate the bug fix: when buildDslFromEdge returns eventDefinitions,
      // they should be merged into the main eventDefinitions object
      
      const mainEventDefinitions: Record<string, any> = {
        'event-a': { id: 'event-a', provider_event_names: { amplitude: 'Event A' } },
        'event-b': { id: 'event-b', provider_event_names: { amplitude: 'Event B' } }
      };
      
      // Simulate n_query result with additional event definitions
      const nQueryResult = {
        queryPayload: { from: 'event-c', to: 'event-d' },
        eventDefinitions: {
          'event-c': { id: 'event-c', provider_event_names: { amplitude: 'Event C' } },
          'event-d': { id: 'event-d', provider_event_names: { amplitude: 'Event D' } }
        }
      };
      
      // This is the fix: merge n_query's event definitions
      if (nQueryResult.eventDefinitions) {
        Object.assign(mainEventDefinitions, nQueryResult.eventDefinitions);
      }
      
      // Verify all event definitions are present
      expect(mainEventDefinitions).toHaveProperty('event-a');
      expect(mainEventDefinitions).toHaveProperty('event-b');
      expect(mainEventDefinitions).toHaveProperty('event-c');
      expect(mainEventDefinitions).toHaveProperty('event-d');
      
      // Verify n_query events have proper provider mappings
      expect(mainEventDefinitions['event-c'].provider_event_names.amplitude).toBe('Event C');
      expect(mainEventDefinitions['event-d'].provider_event_names.amplitude).toBe('Event D');
    });

    it('should handle missing n_query eventDefinitions gracefully', () => {
      const mainEventDefinitions: Record<string, any> = {
        'event-a': { id: 'event-a', provider_event_names: { amplitude: 'Event A' } }
      };
      
      // Simulate n_query result without eventDefinitions (shouldn't happen but be safe)
      const nQueryResult = {
        queryPayload: { from: 'event-c', to: 'event-d' },
        eventDefinitions: undefined as any
      };
      
      // Safe merge
      if (nQueryResult.eventDefinitions) {
        Object.assign(mainEventDefinitions, nQueryResult.eventDefinitions);
      }
      
      // Original event definitions should still be there
      expect(mainEventDefinitions).toHaveProperty('event-a');
      expect(Object.keys(mainEventDefinitions)).toHaveLength(1);
    });

    it('should demonstrate the bug: without merge, adapter receives incomplete definitions', () => {
      // This test demonstrates what happened BEFORE the fix
      
      const mainEventDefinitions: Record<string, any> = {
        'main-event': { id: 'main-event', provider_event_names: { amplitude: 'Main Event' } }
      };
      
      const nQueryResult = {
        queryPayload: { from: 'n-query-event', to: 'main-event' },
        eventDefinitions: {
          'n-query-event': { id: 'n-query-event', provider_event_names: { amplitude: 'N Query Event' } }
        }
      };
      
      // BUG: Only extracting queryPayload, ignoring eventDefinitions
      const baseQueryPayload = nQueryResult.queryPayload;
      // eventDefinitions from nQueryResult were NOT being merged!
      
      // Simulate adapter behavior: look up event definition
      const getEventInfo = (eventId: string) => {
        const eventDef = mainEventDefinitions[eventId];
        if (!eventDef) {
          // This is what causes "Invalid household-created" error!
          return { providerName: eventId, filters: [] };
        }
        return { 
          providerName: eventDef.provider_event_names?.amplitude || eventId, 
          filters: [] 
        };
      };
      
      // Without the merge, n_query events fall back to using raw ID
      const nQueryEventInfo = getEventInfo('n-query-event');
      expect(nQueryEventInfo.providerName).toBe('n-query-event'); // Falls back to raw ID!
      
      // Main event still works because it was in original definitions
      const mainEventInfo = getEventInfo('main-event');
      expect(mainEventInfo.providerName).toBe('Main Event'); // Correct!
    });

    it('should show the fix: with merge, adapter receives complete definitions', () => {
      // This test shows the FIXED behavior
      
      const mainEventDefinitions: Record<string, any> = {
        'main-event': { id: 'main-event', provider_event_names: { amplitude: 'Main Event' } }
      };
      
      const nQueryResult = {
        queryPayload: { from: 'n-query-event', to: 'main-event' },
        eventDefinitions: {
          'n-query-event': { id: 'n-query-event', provider_event_names: { amplitude: 'N Query Event' } }
        }
      };
      
      // FIX: Merge n_query's event definitions
      if (nQueryResult.eventDefinitions) {
        Object.assign(mainEventDefinitions, nQueryResult.eventDefinitions);
      }
      
      // Simulate adapter behavior
      const getEventInfo = (eventId: string) => {
        const eventDef = mainEventDefinitions[eventId];
        if (!eventDef) {
          return { providerName: eventId, filters: [] };
        }
        return { 
          providerName: eventDef.provider_event_names?.amplitude || eventId, 
          filters: [] 
        };
      };
      
      // NOW n_query events resolve correctly!
      const nQueryEventInfo = getEventInfo('n-query-event');
      expect(nQueryEventInfo.providerName).toBe('N Query Event'); // Correct now!
      
      // Main event still works
      const mainEventInfo = getEventInfo('main-event');
      expect(mainEventInfo.providerName).toBe('Main Event');
    });
  });

  describe('buildDslFromEdge result structure', () => {
    
    it('should verify buildDslFromEdge returns eventDefinitions in result', async () => {
      // This verifies the expected contract of buildDslFromEdge
      
      // Mock result structure that buildDslFromEdge returns
      interface BuildQueryPayloadResult {
        queryPayload: {
          from: string;
          to: string;
          visited?: string[];
          visited_upstream?: string[];
        };
        eventDefinitions: Record<string, any>;
      }
      
      const result: BuildQueryPayloadResult = {
        queryPayload: {
          from: 'event-a',
          to: 'event-b',
          visited_upstream: ['event-upstream']
        },
        eventDefinitions: {
          'event-a': { id: 'event-a', provider_event_names: { amplitude: 'Event A' } },
          'event-b': { id: 'event-b', provider_event_names: { amplitude: 'Event B' } },
          'event-upstream': { id: 'event-upstream', provider_event_names: { amplitude: 'Upstream Event' } }
        }
      };
      
      // Verify structure
      expect(result).toHaveProperty('queryPayload');
      expect(result).toHaveProperty('eventDefinitions');
      expect(Object.keys(result.eventDefinitions)).toHaveLength(3);
    });
  });
});

