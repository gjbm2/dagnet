/**
 * Unit tests for buildDslFromEdge context filter extensions (Phase 4)
 * 
 * Tests:
 * - buildContextFilters() with all otherPolicy modes
 * - resolveWindowDates() with relative and absolute dates
 * - Integration with constraints parameter
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDslFromEdge } from '../buildDslFromEdge';
import { parseConstraints } from '../../queryDSL';
import { contextRegistry } from '../../../services/contextRegistry';
import type { ContextDefinition } from '../../../services/contextRegistry';

describe('buildDslFromEdge - Context Filter Extensions', () => {
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================
  // buildContextFilters Tests
  // ===========================================

  describe('buildContextFilters', () => {
    
    it('should generate filter for context with explicit value', async () => {
      // Mock context with explicit Amplitude mapping
      const channelContext: ContextDefinition = {
        id: 'channel',
        name: 'Channel',
        description: 'Marketing channel',
        type: 'categorical',
        values: [
          { id: 'google', label: 'Google', sources: { amplitude: { filter: "utm_source == 'google'" } } },
          { id: 'meta', label: 'Meta', sources: { amplitude: { filter: "utm_source == 'facebook'" } } }
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext);
      
      const edge = {
        id: 'test-edge',
        from: 'a',
        to: 'b',
        p: { mean: 0.5 },
        query: 'from(a).to(b)'
      };
      
      const graph = {
        nodes: [
          { id: 'a', label: 'A', event_id: 'event_a' },
          { id: 'b', label: 'B', event_id: 'event_b' }
        ],
        edges: [edge]
      };
      
      const constraints = parseConstraints('context(channel:google)');
      
      const { queryPayload: result } = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);
      
      expect(result.context_filters).toBeDefined();
      expect(result.context_filters![0]).toEqual(expect.objectContaining({
        field: 'utm_source',
        op: 'is',
        values: ['google']
      }));
    });

    it('should handle otherPolicy: null (no filter for "other")', async () => {
      const channelContext: ContextDefinition = {
        id: 'channel',
        name: 'Channel',
        description: 'Marketing channel',
        type: 'categorical',
        values: [
          { id: 'google', label: 'Google', sources: { amplitude: { filter: "utm_source == 'google'" } } },
          { id: 'other', label: 'Other', sources: { amplitude: { otherPolicy: 'null' } as any } }
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext);
      
      const edge = { id: 'test-edge', from: 'a', to: 'b', p: { mean: 0.5 }, query: 'from(a).to(b)' };
      const graph = {
        nodes: [
          { id: 'a', label: 'A', event_id: 'event_a' },
          { id: 'b', label: 'B', event_id: 'event_b' }
        ],
        edges: [edge]
      };
      
      const constraints = parseConstraints('context(channel:other)');
      const { queryPayload: result } = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);
      
      // otherPolicy: null means no filter (query all data)
      expect(result.context_filters).toBeUndefined();
    });

    it('should handle otherPolicy: computed (generate NOT filter)', async () => {
      const channelContext: ContextDefinition = {
        id: 'channel',
        name: 'Channel',
        description: 'Marketing channel',
        type: 'categorical',
        otherPolicy: 'computed',
        values: [
          { id: 'google', label: 'Google', sources: { amplitude: { filter: "utm_source == 'google'" } } },
          { id: 'meta', label: 'Meta', sources: { amplitude: { filter: "utm_source == 'facebook'" } } },
          { id: 'other', label: 'Other' }
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext);
      
      const edge = { id: 'test-edge', from: 'a', to: 'b', p: { mean: 0.5 }, query: 'from(a).to(b)' };
      const graph = {
        nodes: [
          { id: 'a', label: 'A', event_id: 'event_a' },
          { id: 'b', label: 'B', event_id: 'event_b' }
        ],
        edges: [edge]
      };
      
      const constraints = parseConstraints('context(channel:other)');
      const { queryPayload: result } = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);
      
      // otherPolicy: computed generates "is not" filter with all explicit values
      expect(result.context_filters).toBeDefined();
      expect(result.context_filters![0]).toEqual(expect.objectContaining({
        field: 'utm_source',
        op: 'is not',
        values: expect.arrayContaining(['google', 'facebook'])
      }));
    });

    it('should handle otherPolicy: explicit (use provided filter)', async () => {
      const channelContext: ContextDefinition = {
        id: 'channel',
        name: 'Channel',
        description: 'Marketing channel',
        type: 'categorical',
        otherPolicy: 'explicit',
        values: [
          { id: 'google', label: 'Google', sources: { amplitude: { filter: "utm_source == 'google'" } } },
          { id: 'other', label: 'Other', sources: { amplitude: { filter: "utm_source == 'direct'" } } }
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext);
      
      const edge = { id: 'test-edge', from: 'a', to: 'b', p: { mean: 0.5 }, query: 'from(a).to(b)' };
      const graph = {
        nodes: [
          { id: 'a', label: 'A', event_id: 'event_a' },
          { id: 'b', label: 'B', event_id: 'event_b' }
        ],
        edges: [edge]
      };
      
      const constraints = parseConstraints('context(channel:other)');
      const { queryPayload: result } = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);
      
      // otherPolicy: explicit uses the provided filter
      expect(result.context_filters).toBeDefined();
      expect(result.context_filters![0]).toEqual(expect.objectContaining({
        field: 'utm_source',
        op: 'is',
        values: ['direct']
      }));
    });

    it('should handle regex patterns in filter mappings', async () => {
      const channelContext: ContextDefinition = {
        id: 'channel',
        name: 'Channel',
        description: 'Marketing channel',
        type: 'categorical',
        values: [
          { 
            id: 'social', 
            label: 'Social Media',
            sources: { 
              amplitude: { 
                pattern: '^(facebook|instagram|twitter|linkedin)$',
                patternFlags: 'i',
                field: 'utm_source'
              } 
            } 
          }
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext);
      
      const edge = { id: 'test-edge', from: 'a', to: 'b', p: { mean: 0.5 }, query: 'from(a).to(b)' };
      const graph = {
        nodes: [
          { id: 'a', label: 'A', event_id: 'event_a' },
          { id: 'b', label: 'B', event_id: 'event_b' }
        ],
        edges: [edge]
      };
      
      const constraints = parseConstraints('context(channel:social)');
      const { queryPayload: result } = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);
      
      // Regex pattern should be converted to structured filter with pattern
      expect(result.context_filters).toBeDefined();
      expect(result.context_filters![0]).toEqual(expect.objectContaining({
        field: 'utm_source',
        op: 'matches',
        pattern: '^(facebook|instagram|twitter|linkedin)$',
        patternFlags: 'i'
      }));
    });

    it('should handle multiple context filters (AND logic)', async () => {
      const channelContext: ContextDefinition = {
        id: 'channel',
        name: 'Channel',
        description: 'Marketing channel',
        type: 'categorical',
        values: [
          { id: 'google', label: 'Google', sources: { amplitude: { filter: "utm_source == 'google'" } } }
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      const deviceContext: ContextDefinition = {
        id: 'device',
        name: 'Device',
        description: 'Device type',
        type: 'categorical',
        values: [
          { id: 'mobile', label: 'Mobile', sources: { amplitude: { filter: "device_type == 'mobile'" } } }
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(contextRegistry, 'getContext').mockImplementation(async (id: string) => {
        if (id === 'channel') return channelContext;
        if (id === 'device') return deviceContext;
        return undefined;
      });
      
      const edge = { id: 'test-edge', from: 'a', to: 'b', p: { mean: 0.5 }, query: 'from(a).to(b)' };
      const graph = {
        nodes: [
          { id: 'a', label: 'A', event_id: 'event_a' },
          { id: 'b', label: 'B', event_id: 'event_b' }
        ],
        edges: [edge]
      };
      
      const constraints = parseConstraints('context(channel:google).context(device:mobile)');
      const { queryPayload: result } = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);
      
      // Multiple contexts should result in AND-ed filters (array of filter objects)
      expect(result.context_filters).toBeDefined();
      expect(result.context_filters).toHaveLength(2);
      expect(result.context_filters).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'utm_source', op: 'is', values: ['google'] }),
        expect.objectContaining({ field: 'device_type', op: 'is', values: ['mobile'] })
      ]));
    });
  });

  // ===========================================
  // resolveWindowDates Tests
  // ===========================================

  describe('resolveWindowDates', () => {
    
    it('should resolve relative offset: -30d:', async () => {
      const edge = { id: 'test-edge', from: 'a', to: 'b', p: { mean: 0.5 }, query: 'from(a).to(b)' };
      const graph = {
        nodes: [
          { id: 'a', label: 'A', event_id: 'event_a' },
          { id: 'b', label: 'B', event_id: 'event_b' }
        ],
        edges: [edge]
      };
      
      const constraints = parseConstraints('window(-30d:)');
      const { queryPayload: result } = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);
      
      expect(result.start).toBeDefined();
      expect(result.end).toBeUndefined(); // Open-ended
      
      // Verify start date is ~30 days ago (allow 1 day tolerance)
      const startDate = new Date(result.start!);
      const expected = new Date();
      expected.setDate(expected.getDate() - 30);
      
      const diff = Math.abs(startDate.getTime() - expected.getTime());
      const daysDiff = diff / (1000 * 60 * 60 * 24);
      expect(daysDiff).toBeLessThan(1);
    });

    it('should resolve relative range: -2w:-1w', async () => {
      const edge = { id: 'test-edge', from: 'a', to: 'b', p: { mean: 0.5 }, query: 'from(a).to(b)' };
      const graph = {
        nodes: [
          { id: 'a', label: 'A', event_id: 'event_a' },
          { id: 'b', label: 'B', event_id: 'event_b' }
        ],
        edges: [edge]
      };
      
      const constraints = parseConstraints('window(-2w:-1w)');
      const { queryPayload: result } = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);
      
      expect(result.start).toBeDefined();
      expect(result.end).toBeDefined();
      
      // Verify dates are ~2 weeks and ~1 week ago
      const startDate = new Date(result.start!);
      const endDate = new Date(result.end!);
      const now = new Date();
      
      const startExpected = new Date(now);
      startExpected.setDate(now.getDate() - 14);
      
      const endExpected = new Date(now);
      endExpected.setDate(now.getDate() - 7);
      
      const startDiff = Math.abs(startDate.getTime() - startExpected.getTime()) / (1000 * 60 * 60 * 24);
      const endDiff = Math.abs(endDate.getTime() - endExpected.getTime()) / (1000 * 60 * 60 * 24);
      
      expect(startDiff).toBeLessThan(1);
      expect(endDiff).toBeLessThan(1);
    });

    it('should handle absolute dates: 1-Jan-25:31-Dec-25', async () => {
      const edge = { id: 'test-edge', from: 'a', to: 'b', p: { mean: 0.5 }, query: 'from(a).to(b)' };
      const graph = {
        nodes: [
          { id: 'a', label: 'A', event_id: 'event_a' },
          { id: 'b', label: 'B', event_id: 'event_b' }
        ],
        edges: [edge]
      };
      
      const constraints = parseConstraints('window(1-Jan-25:31-Dec-25)');
      const { queryPayload: result } = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);
      
      expect(result.start).toBeDefined();
      expect(result.end).toBeDefined();
      
      // Verify dates match expected
      const startDate = new Date(result.start!);
      const endDate = new Date(result.end!);
      
      expect(startDate.getFullYear()).toBe(2025);
      expect(startDate.getMonth()).toBe(0); // January = 0
      expect(startDate.getDate()).toBe(1);
      
      expect(endDate.getFullYear()).toBe(2025);
      expect(endDate.getMonth()).toBe(11); // December = 11
      expect(endDate.getDate()).toBe(31);
    });

    it('should handle open-ended future: :-30d (from past to 30 days ago)', async () => {
      const edge = { id: 'test-edge', from: 'a', to: 'b', p: { mean: 0.5 }, query: 'from(a).to(b)' };
      const graph = {
        nodes: [
          { id: 'a', label: 'A', event_id: 'event_a' },
          { id: 'b', label: 'B', event_id: 'event_b' }
        ],
        edges: [edge]
      };
      
      const constraints = parseConstraints('window(:-30d)');
      const { queryPayload: result } = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);
      
      expect(result.start).toBeUndefined(); // Open-ended past
      expect(result.end).toBeDefined();
      
      // Verify end date is ~30 days ago
      const endDate = new Date(result.end!);
      const expected = new Date();
      expected.setDate(expected.getDate() - 30);
      
      const diff = Math.abs(endDate.getTime() - expected.getTime());
      const daysDiff = diff / (1000 * 60 * 60 * 24);
      expect(daysDiff).toBeLessThan(1);
    });
  });

  // ===========================================
  // Integration Tests
  // ===========================================

  describe('Integration: context + window', () => {
    
    it('should combine context filters and window dates', async () => {
      const channelContext: ContextDefinition = {
        id: 'channel',
        name: 'Channel',
        description: 'Marketing channel',
        type: 'categorical',
        values: [
          { id: 'google', label: 'Google', sources: { amplitude: { filter: "utm_source == 'google'" } } }
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext);
      
      const edge = { id: 'test-edge', from: 'a', to: 'b', p: { mean: 0.5 }, query: 'from(a).to(b)' };
      const graph = {
        nodes: [
          { id: 'a', label: 'A', event_id: 'event_a' },
          { id: 'b', label: 'B', event_id: 'event_b' }
        ],
        edges: [edge]
      };
      
      const constraints = parseConstraints('context(channel:google).window(-30d:)');
      const { queryPayload: result } = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);
      
      // Should have both context filter and window dates
      expect(result.context_filters).toBeDefined();
      expect(result.context_filters![0]).toEqual(expect.objectContaining({
        field: 'utm_source',
        op: 'is',
        values: ['google']
      }));
      expect(result.start).toBeDefined();
      expect(result.end).toBeUndefined();
    });
  });
});

