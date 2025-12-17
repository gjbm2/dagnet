import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDslFromEdge } from '../buildDslFromEdge';
import { parseConstraints } from '../../queryDSL';
import { contextRegistry } from '../../../services/contextRegistry';
import type { ContextDefinition } from '../../../services/contextRegistry';

describe('buildDslFromEdge - cohort().context() produces cohort bounds + context_filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes queryPayload.cohort and queryPayload.context_filters for cohort+context constraints', async () => {
    const channelContext: ContextDefinition = {
      id: 'channel',
      name: 'Channel',
      description: 'Marketing channel',
      type: 'categorical',
      values: [
        { id: 'google', label: 'Google', sources: { amplitude: { filter: "utm_medium == 'cpc'" } } as any },
      ],
      metadata: { created_at: '1-Jan-25', version: '1.0.0', status: 'active' } as any,
    };

    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext);

    const edge = {
      id: 'test-edge',
      from: 'a',
      to: 'b',
      p: { mean: 0.5 },
      query: 'from(a).to(b)',
    };

    const graph = {
      nodes: [
        { id: 'a', label: 'A', event_id: 'event_a' },
        { id: 'b', label: 'B', event_id: 'event_b' },
      ],
      edges: [edge],
    };

    const constraints = parseConstraints('cohort(anchor,1-Nov-25:3-Nov-25).context(channel:google)');
    const { queryPayload } = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);

    expect(queryPayload.cohort).toBeDefined();
    expect(queryPayload.cohort?.start).toBe('2025-11-01T00:00:00.000Z');
    // Cohort dates are represented as UTC-midnight ISO instants; adapters treat them as day-granular bounds.
    expect(queryPayload.cohort?.end).toBe('2025-11-03T00:00:00.000Z');

    expect(queryPayload.context_filters).toBeDefined();
    expect(queryPayload.context_filters?.length).toBe(1);
    expect(queryPayload.context_filters?.[0]).toEqual(
      expect.objectContaining({
        field: 'utm_medium',
        op: 'is',
        values: ['cpc'],
      })
    );
  });
});


