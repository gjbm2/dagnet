import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeQuerySignature } from '../dataOperationsService';
import { contextRegistry } from '../contextRegistry';

describe('computeQuerySignature - context_filters', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    contextRegistry.clearCache();
  });

  it('does not change when context_filters predicate changes if context definition is unchanged', async () => {
    const basePayload: any = {
      from: 'a',
      to: 'b',
      context: [{ key: 'channel', value: 'other' }],
    };
    const contextDef = {
      id: 'channel',
      name: 'Marketing Channel',
      description: 'Primary acquisition channel',
      type: 'categorical',
      otherPolicy: 'computed',
      values: [
        { id: 'paid-search', label: 'Paid Search' },
        { id: 'influencer', label: 'Influencer' },
        { id: 'paid-social', label: 'Paid Social' },
        { id: 'other', label: 'Other' },
      ],
      metadata: {
        category: 'marketing',
        data_source: 'utm_parameters',
        created_at: '1-Dec-25',
        version: '1.0.0',
        status: 'active',
      },
    };
    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(contextDef as any);

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

    expect(sig1).toEqual(sig2);
  });

  it('does not change when original_query embeds context(value) (value must not affect signature)', async () => {
    const basePayload: any = {
      from: 'a',
      to: 'b',
      context: [{ key: 'channel', value: 'paid-search' }],
    };

    const contextDef = {
      id: 'channel',
      name: 'Marketing Channel',
      description: 'Primary acquisition channel',
      type: 'categorical',
      otherPolicy: 'computed',
      values: [
        { id: 'paid-search', label: 'Paid Search' },
        { id: 'influencer', label: 'Influencer' },
        { id: 'paid-social', label: 'Paid Social' },
        { id: 'other', label: 'Other' },
      ],
      metadata: {
        category: 'marketing',
        data_source: 'utm_parameters',
        created_at: '1-Dec-25',
        version: '1.0.0',
        status: 'active',
      },
    };
    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(contextDef as any);

    const sig1 = await computeQuerySignature(
      basePayload,
      'amplitude-prod',
      undefined,
      { query: 'from(a).to(b).context(channel:paid-search)' }
    );

    const sig2 = await computeQuerySignature(
      basePayload,
      'amplitude-prod',
      undefined,
      { query: 'from(a).to(b).context(channel:other)' }
    );

    expect(sig1).toEqual(sig2);
  });

  it('changes when context definition changes (context hash)', async () => {
    const basePayload: any = {
      from: 'a',
      to: 'b',
      context: [{ key: 'channel', value: 'other' }],
    };

    const contextDefV1 = {
      id: 'channel',
      name: 'Marketing Channel',
      description: 'Primary acquisition channel',
      type: 'categorical',
      otherPolicy: 'computed',
      values: [
        { id: 'paid-search', label: 'Paid Search' },
        { id: 'influencer', label: 'Influencer' },
        { id: 'paid-social', label: 'Paid Social' },
        { id: 'other', label: 'Other' },
      ],
      metadata: {
        category: 'marketing',
        data_source: 'utm_parameters',
        created_at: '1-Dec-25',
        version: '1.0.0',
        status: 'active',
      },
    };

    const contextDefV2 = {
      ...contextDefV1,
      values: [
        ...contextDefV1.values,
        { id: 'referral', label: 'Referral' },
      ],
      metadata: {
        ...contextDefV1.metadata,
        version: '1.1.0',
      },
    };

    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(contextDefV1 as any);
    const sig1 = await computeQuerySignature(basePayload, 'amplitude-prod', undefined, undefined, ['channel'], undefined);

    contextRegistry.clearCache();
    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(contextDefV2 as any);
    const sig2 = await computeQuerySignature(basePayload, 'amplitude-prod', undefined, undefined, ['channel'], undefined);

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

    // Graph is required for anchor_node_id → event_id resolution
    // Without a graph, anchor_node_id cannot be resolved and both signatures would be identical
    const graphWithNodes: any = {
      nodes: [
        { id: 'A', event_id: 'event-A' },
        { id: 'B', event_id: 'event-B' },
        { id: 'Z', event_id: 'event-Z' },  // Different event_id
      ],
    };

    const edgeBase: any = {
      query: 'from(A).to(B)',
      p: { latency: { latency_parameter: true, anchor_node_id: 'A' } },
    };

    const sig1 = await computeQuerySignature(basePayload, 'amplitude-prod', graphWithNodes, edgeBase);
    const sig2 = await computeQuerySignature(
      { ...basePayload, cohort: { ...basePayload.cohort, anchor_event_id: 'event-anchor-Z' } },
      'amplitude-prod',
      graphWithNodes,
      edgeBase
    );
    const sig3 = await computeQuerySignature(
      basePayload,
      'amplitude-prod',
      graphWithNodes,
      { ...edgeBase, p: { latency: { latency_parameter: true, anchor_node_id: 'Z' } } }  // Different anchor node → different event_id
    );

    expect(sig1).not.toEqual(sig2);
    expect(sig1).not.toEqual(sig3);
  });
});


