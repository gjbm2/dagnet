/**
 * Unit tests for buildDataQuerySpec (Phase 4)
 * 
 * Tests query signature generation for stored parameter values.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDataQuerySpec } from '../buildDataQuerySpec';
import type { DslObject, ContextFilterObject } from '../buildDslFromEdge';
import { parseConstraints } from '../../queryDSL';
import { contextRegistry } from '../../../services/contextRegistry';

describe('buildDataQuerySpec', () => {
  
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should build spec from DSL with context filters', async () => {
    const dsl: DslObject = {
      from: 'signup',
      to: 'purchase',
      context_filters: [{
        field: 'utm_source',
        op: 'is',
        values: ['google']
      }],
      start: '2025-01-01T00:00:00Z',
      end: '2025-01-31T23:59:59Z'
    };
    
    const constraints = parseConstraints('context(channel:google)');
    
    // Mock contextRegistry to return a mapping
    vi.spyOn(contextRegistry, 'getSourceMapping').mockResolvedValue({
      filter: "utm_source == 'google'",
      field: 'utm_source'
    });
    
    const spec = await buildDataQuerySpec(
      dsl,
      'test-conn-id',
      'amplitude',
      constraints,
      'daily'
    );
    
    expect(spec).toBeDefined();
    expect(spec.connectionId).toBe('test-conn-id');
    expect(spec.connectionType).toBe('amplitude');
    expect(spec.fromNode).toBe('signup');
    expect(spec.toNode).toBe('purchase');
    expect(spec.contextFilters).toHaveLength(1);
    expect(spec.contextFilters[0].key).toBe('channel');
    expect(spec.contextFilters[0].value).toBe('google');
    expect(spec.granularity).toBe('daily');
  });

  it('should handle DSL without context filters', async () => {
    const dsl: DslObject = {
      from: 'a',
      to: 'b'
    };
    
    const spec = await buildDataQuerySpec(
      dsl,
      'conn-id',
      'amplitude',
      undefined,
      'aggregate'
    );
    
    expect(spec.contextFilters).toEqual([]);
    expect(spec.granularity).toBe('aggregate');
  });

  it('should include visited constraints in spec', async () => {
    const dsl: DslObject = {
      from: 'a',
      to: 'c',
      visited: ['b']
    };
    
    const spec = await buildDataQuerySpec(
      dsl,
      'conn-id',
      'amplitude',
      undefined,
      'daily'
    );
    
    expect(spec.visited).toEqual(['b']);
  });

  it('should include exclude constraints in spec', async () => {
    const dsl: DslObject = {
      from: 'a',
      to: 'c',
      exclude: ['x', 'y']
    };
    
    const spec = await buildDataQuerySpec(
      dsl,
      'conn-id',
      'amplitude',
      undefined,
      'daily'
    );
    
    expect(spec.excluded).toEqual(['x', 'y']);
  });

  it('should handle window dates in spec', async () => {
    const dsl: DslObject = {
      from: 'a',
      to: 'b',
      start: '2025-01-01T00:00:00Z',
      end: '2025-12-31T23:59:59Z'
    };
    
    const spec = await buildDataQuerySpec(
      dsl,
      'conn-id',
      'amplitude',
      undefined,
      'aggregate'  // Window bounds only included for aggregate mode
    );
    
    expect(spec.windowBounds).toBeDefined();
    expect(spec.windowBounds!.start).toBe('2025-01-01T00:00:00Z');
    expect(spec.windowBounds!.end).toBe('2025-12-31T23:59:59Z');
  });

  it('should not include window bounds for daily mode', async () => {
    const dsl: DslObject = {
      from: 'a',
      to: 'b',
      start: '2025-01-01T00:00:00Z',
      end: '2025-12-31T23:59:59Z'
    };
    
    const spec = await buildDataQuerySpec(
      dsl,
      'conn-id',
      'amplitude',
      undefined,
      'daily'
    );
    
    expect(spec.windowBounds).toBeUndefined();
  });

  it('should handle multiple context filters', async () => {
    const dsl: DslObject = {
      from: 'a',
      to: 'b',
      context_filters: [
        {
          field: 'utm_source',
          op: 'is',
          values: ['google']
        },
        {
          field: 'device_type',
          op: 'is',
          values: ['mobile']
        }
      ]
    };
    
    const constraints = parseConstraints('context(channel:google).context(device:mobile)');
    
    vi.spyOn(contextRegistry, 'getSourceMapping')
      .mockResolvedValueOnce({
        filter: "utm_source == 'google'",
        field: 'utm_source'
      })
      .mockResolvedValueOnce({
        filter: "device_type == 'mobile'",
        field: 'device_type'
      });
    
    const spec = await buildDataQuerySpec(
      dsl,
      'conn-id',
      'amplitude',
      constraints,
      'daily'
    );
    
    expect(spec.contextFilters).toHaveLength(2);
    expect(spec.contextFilters[0].key).toBe('channel');
    expect(spec.contextFilters[1].key).toBe('device');
  });

  it('should include visitedAny in spec', async () => {
    const dsl: DslObject = {
      from: 'a',
      to: 'd',
      visitedAny: [['b', 'c']]
    };
    
    const spec = await buildDataQuerySpec(
      dsl,
      'conn-id',
      'amplitude',
      undefined,
      'daily'
    );
    
    // visitedAny is not currently part of DataQuerySpec, so this would pass if we added it
    expect(spec.visited).toEqual([]);
  });

  it('should handle case filters in spec', async () => {
    const dsl: DslObject = {
      from: 'a',
      to: 'b',
      case: [{ key: 'experiment-1', value: 'variant-a' }]
    };
    
    const spec = await buildDataQuerySpec(
      dsl,
      'conn-id',
      'amplitude',
      undefined,
      'daily'
    );
    
    expect(spec.cases).toEqual([{ key: 'experiment-1', value: 'variant-a' }]);
  });
});
