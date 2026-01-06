import { describe, it, expect } from 'vitest';
import { computeQuerySignature } from '../dataOperationsService';

describe('computeQuerySignature - context_filters', () => {
  it('changes when context_filters predicate changes even if context key/value stays the same', async () => {
    const basePayload: any = {
      from: 'a',
      to: 'b',
      context: [{ key: 'channel', value: 'other' }],
    };

    const sig1 = await computeQuerySignature(
      {
        ...basePayload,
        context_filters: [
          { field: 'utm_medium', op: 'is not', values: [], pattern: '^(cpc)$', patternFlags: 'i' },
        ],
      },
      'amplitude-prod'
    );

    const sig2 = await computeQuerySignature(
      {
        ...basePayload,
        context_filters: [
          { field: 'utm_medium', op: 'is not', values: [], pattern: '^(cpc|paid-social)$', patternFlags: 'i' },
        ],
      },
      'amplitude-prod'
    );

    expect(sig1).not.toEqual(sig2);
  });

  it('changes when latency / cohort semantics change (anchor)', async () => {
    const basePayload: any = {
      from: 'a',
      to: 'b',
      cohort: {
        // Bounds are intentionally NOT part of the signature; keep them constant here anyway.
        start: '2025-01-01T00:00:00Z',
        end: '2025-01-31T23:59:59Z',
        anchor_event_id: 'event-anchor-A',
        conversion_window_days: 14,
      },
    };

    const edgeBase: any = {
      query: 'from(A).to(B)',
      p: { latency: { latency_parameter: true, anchor_node_id: 'A' } },
    };

    const sig1 = await computeQuerySignature(basePayload, 'amplitude-prod', undefined, edgeBase);
    const sig2 = await computeQuerySignature(
      { ...basePayload, cohort: { ...basePayload.cohort, anchor_event_id: 'event-anchor-Z' } },
      'amplitude-prod',
      undefined,
      edgeBase
    );
    const sig3 = await computeQuerySignature(
      basePayload,
      'amplitude-prod',
      undefined,
      { ...edgeBase, p: { latency: { latency_parameter: true, anchor_node_id: 'Z' } } }
    );

    expect(sig1).not.toEqual(sig2);
    expect(sig1).not.toEqual(sig3);
  });
});


