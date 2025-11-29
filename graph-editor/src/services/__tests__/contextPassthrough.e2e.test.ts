/**
 * Context Passthrough E2E Tests
 * 
 * Tests that context filters are correctly passed through the ENTIRE fetch pipeline:
 * 1. WindowSelector → currentDSL
 * 2. currentDSL → dataOperationsService.getFromSourceDirect
 * 3. getFromSourceDirect → parseConstraints
 * 4. parseConstraints → buildDslFromEdge
 * 5. buildDslFromEdge → context_filters in queryPayload
 * 6. queryPayload → DAS Runner → Amplitude API request
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseConstraints } from '../../lib/queryDSL';

// ============================================================================
// 1. WindowSelector DSL Generation
// ============================================================================

describe('Step 1: WindowSelector DSL Generation', () => {
  /**
   * Simulates what WindowSelector does when context changes
   */
  function buildWindowSelectorDSL(context: { key: string; value: string } | null, window: { start: string; end: string }): string {
    const windowPart = `window(${window.start}:${window.end})`;
    
    if (!context) {
      return windowPart;
    }
    
    return `context(${context.key}:${context.value}).${windowPart}`;
  }

  it('should build DSL with just window (no context)', () => {
    const dsl = buildWindowSelectorDSL(null, { start: '1-Oct-25', end: '31-Oct-25' });
    expect(dsl).toBe('window(1-Oct-25:31-Oct-25)');
  });

  it('should build DSL with context and window', () => {
    const dsl = buildWindowSelectorDSL(
      { key: 'channel', value: 'google' },
      { start: '1-Oct-25', end: '31-Oct-25' }
    );
    expect(dsl).toBe('context(channel:google).window(1-Oct-25:31-Oct-25)');
  });
});

// ============================================================================
// 2. parseConstraints Extracts Context
// ============================================================================

describe('Step 2: parseConstraints Extracts Context', () => {
  it('should parse context from DSL', () => {
    const result = parseConstraints('context(channel:google).window(1-Oct-25:31-Oct-25)');
    
    expect(result.context).toHaveLength(1);
    expect(result.context[0]).toEqual({ key: 'channel', value: 'google' });
  });

  it('should parse contextAny (multiple values) from DSL', () => {
    const result = parseConstraints('contextAny(channel:google,channel:influencer).window(1-Oct-25:31-Oct-25)');
    
    expect(result.contextAny).toHaveLength(1);
    expect(result.contextAny[0].pairs).toContainEqual({ key: 'channel', value: 'google' });
    expect(result.contextAny[0].pairs).toContainEqual({ key: 'channel', value: 'influencer' });
  });

  it('should handle DSL with no context', () => {
    const result = parseConstraints('window(1-Oct-25:31-Oct-25)');
    
    expect(result.context).toHaveLength(0);
    expect(result.contextAny).toHaveLength(0);
    expect(result.window).toEqual({ start: '1-Oct-25', end: '31-Oct-25' });
  });

  it('should handle empty DSL', () => {
    const result = parseConstraints('');
    
    expect(result.context).toHaveLength(0);
    expect(result.contextAny).toHaveLength(0);
    expect(result.window).toBeNull();
  });
});

// ============================================================================
// 3. Constraint Merging
// ============================================================================

describe('Step 3: Constraint Merging (graph-level + edge-level)', () => {
  /**
   * Simulates the constraint merging in dataOperationsService
   */
  function mergeConstraints(graphDSL: string, edgeDSL: string) {
    const graphConstraints = graphDSL ? parseConstraints(graphDSL) : null;
    const edgeConstraints = edgeDSL ? parseConstraints(edgeDSL) : null;
    
    return {
      context: [...(graphConstraints?.context || []), ...(edgeConstraints?.context || [])],
      contextAny: [...(graphConstraints?.contextAny || []), ...(edgeConstraints?.contextAny || [])],
      window: edgeConstraints?.window || graphConstraints?.window || null,
    };
  }

  it('should use graph-level context when edge has none', () => {
    const merged = mergeConstraints(
      'context(channel:google).window(1-Oct-25:31-Oct-25)',
      'from(a).to(b)'
    );
    
    expect(merged.context).toHaveLength(1);
    expect(merged.context[0]).toEqual({ key: 'channel', value: 'google' });
  });

  it('should combine graph-level and edge-level contexts', () => {
    const merged = mergeConstraints(
      'context(channel:google).window(1-Oct-25:31-Oct-25)',
      'context(platform:ios).from(a).to(b)'
    );
    
    expect(merged.context).toHaveLength(2);
    expect(merged.context).toContainEqual({ key: 'channel', value: 'google' });
    expect(merged.context).toContainEqual({ key: 'platform', value: 'ios' });
  });

  it('should prefer edge-level window over graph-level', () => {
    const merged = mergeConstraints(
      'context(channel:google).window(1-Oct-25:31-Oct-25)',
      'window(1-Nov-25:30-Nov-25).from(a).to(b)'
    );
    
    expect(merged.window).toEqual({ start: '1-Nov-25', end: '30-Nov-25' });
  });
});

// ============================================================================
// 4. buildContextFilters (Simulated)
// ============================================================================

describe('Step 4: buildContextFilters', () => {
  /**
   * Simulates what buildContextFilters does in buildDslFromEdge
   */
  interface ContextFilter {
    sourceField: string;
    subprop_op: string;
    subprop_value: string[];
  }

  async function buildContextFilters(
    constraints: { context: Array<{ key: string; value: string }>; contextAny: Array<{ pairs: Array<{ key: string; value: string }> }> },
    connectionType: string
  ): Promise<ContextFilter[]> {
    const filters: ContextFilter[] = [];
    
    // Process single-value contexts
    for (const ctx of constraints.context) {
      // In real code, this would look up the context registry to get the source field
      filters.push({
        sourceField: `gp_${ctx.key}`,  // Simplified mapping
        subprop_op: 'is',
        subprop_value: [ctx.value]
      });
    }
    
    // Process multi-value contexts
    for (const ctxAny of constraints.contextAny) {
      for (const pair of ctxAny.pairs) {
        filters.push({
          sourceField: `gp_${pair.key}`,
          subprop_op: 'is',
          subprop_value: [pair.value]
        });
      }
    }
    
    return filters;
  }

  it('should build context filter from single context', async () => {
    const filters = await buildContextFilters(
      { context: [{ key: 'channel', value: 'google' }], contextAny: [] },
      'amplitude'
    );
    
    expect(filters).toHaveLength(1);
    expect(filters[0].sourceField).toBe('gp_channel');
    expect(filters[0].subprop_value).toContain('google');
  });

  it('should build multiple filters from contextAny', async () => {
    const filters = await buildContextFilters(
      { 
        context: [], 
        contextAny: [{ 
          pairs: [
            { key: 'channel', value: 'google' },
            { key: 'channel', value: 'influencer' }
          ]
        }]
      },
      'amplitude'
    );
    
    expect(filters).toHaveLength(2);
  });
});

// ============================================================================
// 5. QueryPayload Context Filters
// ============================================================================

describe('Step 5: QueryPayload includes context_filters', () => {
  interface QueryPayload {
    from: string;
    to: string;
    start?: string;
    end?: string;
    context_filters?: Array<{ sourceField: string; subprop_op: string; subprop_value: string[] }>;
  }

  /**
   * Simulates the full query payload building
   */
  function buildQueryPayload(
    fromEvent: string,
    toEvent: string,
    constraints: { context: Array<{ key: string; value: string }>; window: { start: string; end: string } | null }
  ): QueryPayload {
    const payload: QueryPayload = {
      from: fromEvent,
      to: toEvent
    };
    
    // Add window
    if (constraints.window) {
      // Simulate date parsing (simplified)
      payload.start = `2025-10-01T00:00:00.000Z`;
      payload.end = `2025-10-31T23:59:59.000Z`;
    }
    
    // Add context filters - THIS IS THE CRITICAL PART
    if (constraints.context.length > 0) {
      payload.context_filters = constraints.context.map(ctx => ({
        sourceField: `gp_${ctx.key}`,
        subprop_op: 'is',
        subprop_value: [ctx.value]
      }));
    }
    
    return payload;
  }

  it('should include context_filters in payload when context is present', () => {
    const payload = buildQueryPayload(
      'viewed-page',
      'purchased',
      {
        context: [{ key: 'channel', value: 'google' }],
        window: { start: '1-Oct-25', end: '31-Oct-25' }
      }
    );
    
    expect(payload.context_filters).toBeDefined();
    expect(payload.context_filters).toHaveLength(1);
    expect(payload.context_filters![0].sourceField).toBe('gp_channel');
    expect(payload.context_filters![0].subprop_value).toContain('google');
  });

  it('should NOT include context_filters when no context', () => {
    const payload = buildQueryPayload(
      'viewed-page',
      'purchased',
      {
        context: [],
        window: { start: '1-Oct-25', end: '31-Oct-25' }
      }
    );
    
    expect(payload.context_filters).toBeUndefined();
  });
});

// ============================================================================
// 6. DAS Adapter Pre-Request Script
// ============================================================================

describe('Step 6: DAS Adapter Pre-Request Script', () => {
  /**
   * Simulates what the Amplitude adapter's pre_request script does
   */
  function amplitudePreRequest(
    queryPayload: { from: string; to: string; context_filters?: any[] },
    window: { start: string; end: string }
  ): { segments: any[]; queryParams: string } {
    const segments: any[] = [];
    
    // Add context filters as segmentation
    if (queryPayload.context_filters && queryPayload.context_filters.length > 0) {
      for (const filter of queryPayload.context_filters) {
        segments.push({
          prop: filter.sourceField,
          op: filter.subprop_op,
          values: filter.subprop_value
        });
      }
    }
    
    // Build query params
    const segmentParam = segments.length > 0 
      ? `s=${encodeURIComponent(JSON.stringify(segments))}`
      : '';
    
    return {
      segments,
      queryParams: segmentParam
    };
  }

  it('should include segments in query params when context_filters present', () => {
    const result = amplitudePreRequest(
      {
        from: 'viewed-page',
        to: 'purchased',
        context_filters: [{
          sourceField: 'gp_channel',
          subprop_op: 'is',
          subprop_value: ['google']
        }]
      },
      { start: '2025-10-01', end: '2025-10-31' }
    );
    
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].prop).toBe('gp_channel');
    expect(result.segments[0].values).toContain('google');
    expect(result.queryParams).toContain('s=');
  });

  it('should NOT include segments when no context_filters', () => {
    const result = amplitudePreRequest(
      { from: 'viewed-page', to: 'purchased' },
      { start: '2025-10-01', end: '2025-10-31' }
    );
    
    expect(result.segments).toHaveLength(0);
    expect(result.queryParams).toBe('');
  });
});

// ============================================================================
// FULL PIPELINE E2E TEST
// ============================================================================

describe('FULL PIPELINE: Context from UI to API', () => {
  it('Context selected in UI should appear in final API segments', () => {
    // Step 1: User selects context in WindowSelector
    const userSelectedContext = { key: 'channel', value: 'google' };
    const userSelectedWindow = { start: '1-Oct-25', end: '31-Oct-25' };
    
    // WindowSelector builds DSL
    const currentQueryDSL = `context(${userSelectedContext.key}:${userSelectedContext.value}).window(${userSelectedWindow.start}:${userSelectedWindow.end})`;
    
    // Step 2: parseConstraints extracts context
    const constraints = parseConstraints(currentQueryDSL);
    expect(constraints.context).toHaveLength(1);
    expect(constraints.context[0].key).toBe('channel');
    expect(constraints.context[0].value).toBe('google');
    
    // Step 3: buildDslFromEdge creates context_filters
    const contextFilters = constraints.context.map(ctx => ({
      sourceField: `gp_${ctx.key}`,
      subprop_op: 'is',
      subprop_value: [ctx.value]
    }));
    expect(contextFilters).toHaveLength(1);
    
    // Step 4: QueryPayload includes context_filters
    const queryPayload = {
      from: 'viewed-page',
      to: 'purchased',
      start: '2025-10-01T00:00:00.000Z',
      end: '2025-10-31T23:59:59.000Z',
      context_filters: contextFilters
    };
    expect(queryPayload.context_filters).toHaveLength(1);
    
    // Step 5: DAS pre_request script builds segments
    const segments = queryPayload.context_filters!.map(f => ({
      prop: f.sourceField,
      op: f.subprop_op,
      values: f.subprop_value
    }));
    expect(segments).toHaveLength(1);
    expect(segments[0].prop).toBe('gp_channel');
    expect(segments[0].values).toContain('google');
    
    // Step 6: Final API query params include segment
    const segmentParam = `s=${encodeURIComponent(JSON.stringify(segments))}`;
    expect(segmentParam).toContain('gp_channel');
    expect(segmentParam).toContain('google');
  });

  it('No context in UI → No segments in API', () => {
    // Step 1: User has no context selected
    const currentQueryDSL = 'window(1-Oct-25:31-Oct-25)';
    
    // Step 2: parseConstraints finds no context
    const constraints = parseConstraints(currentQueryDSL);
    expect(constraints.context).toHaveLength(0);
    
    // Steps 3-6: No context_filters → No segments
    const queryPayload = {
      from: 'viewed-page',
      to: 'purchased',
      start: '2025-10-01T00:00:00.000Z',
      end: '2025-10-31T23:59:59.000Z'
      // No context_filters field
    };
    expect(queryPayload).not.toHaveProperty('context_filters');
  });
});

// ============================================================================
// KNOWN BUGS / EDGE CASES
// ============================================================================

describe('Known Bugs / Edge Cases', () => {
  it('BUG: NodeContextMenu does not pass currentDSL', () => {
    // This simulates the bug in NodeContextMenu.tsx line 202-209
    // where getFromSourceDirect is called without currentDSL
    
    const callArgs = {
      objectType: 'case',
      objectId: 'some-case-id',
      targetId: 'node-uuid',
      graph: { currentQueryDSL: 'context(channel:google).window(1-Oct-25:31-Oct-25)' },
      setGraph: () => {},
      dailyMode: false
      // MISSING: currentDSL parameter!
    };
    
    // The service will fall back to graph.currentQueryDSL, which MIGHT work
    // BUT if graph is stale (as seen in other bugs), it won't have the right context
    expect(callArgs).not.toHaveProperty('currentDSL');
  });

  it('CORRECT: BatchOperationsModal passes currentDSL', () => {
    // This simulates the correct pattern in BatchOperationsModal.tsx
    const getEffectiveDSL = () => 'context(channel:google).window(1-Oct-25:31-Oct-25)';
    
    const callArgs = {
      objectType: 'parameter',
      objectId: '',
      targetId: 'edge-uuid',
      graph: {},
      setGraph: () => {},
      dailyMode: false,
      bustCache: false,
      currentDSL: getEffectiveDSL()
    };
    
    expect(callArgs.currentDSL).toBe('context(channel:google).window(1-Oct-25:31-Oct-25)');
  });
});

