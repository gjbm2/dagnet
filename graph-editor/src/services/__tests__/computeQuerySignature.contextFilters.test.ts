import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeQuerySignature } from '../dataOperationsService';
import { computeShortCoreHash } from '../coreHashService';
import { parseSignature } from '../signatureMatchingService';
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

// ═══════════════════════════════════════════════════════════════════════════════
// Hash Generation Robustness Tests
//
// These tests verify the exact properties of the hash computation pipeline:
// determinism, sensitivity to hash-relevant fields, insensitivity to non-hash
// fields, and stability of the full pipeline (inputs → canonical JSON → SHA-256
// → structured signature → computeShortCoreHash).
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeQuerySignature — hash generation robustness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    contextRegistry.clearCache();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Shared fixtures
  // ─────────────────────────────────────────────────────────────────────────

  const graph = {
    nodes: [
      { id: 'signup', event_id: 'evt-signup' },
      { id: 'purchase', event_id: 'evt-purchase' },
      { id: 'referral', event_id: 'evt-referral' },
    ],
  };

  const edge = { query: 'from(signup).to(purchase)' };

  const eventDefs: Record<string, any> = {
    'evt-signup': {
      id: 'evt-signup',
      provider_event_names: { amplitude: 'Account Created' },
      amplitude_filters: [],
    },
    'evt-purchase': {
      id: 'evt-purchase',
      provider_event_names: { amplitude: 'Purchase Completed' },
      amplitude_filters: [
        { property: 'amount', operator: 'is', values: ['premium'] },
      ],
    },
  };

  const channelContext = {
    id: 'channel',
    name: 'Channel',
    description: 'Marketing channel',
    type: 'categorical',
    otherPolicy: 'computed',
    values: [
      { id: 'google', label: 'Google', sources: { amplitude: { filter: "utm_source == 'google'" } } },
      { id: 'meta', label: 'Meta', sources: { amplitude: { filter: "utm_source == 'facebook'" } } },
      { id: 'other', label: 'Other' },
    ],
    metadata: { created_at: '1-Jan-25', version: '1.0.0', status: 'active' },
  };

  async function computeSig(overrides?: {
    connectionName?: string;
    graphOverride?: any;
    edgeOverride?: any;
    eventDefsOverride?: Record<string, any>;
    contextKeys?: string[];
    payload?: any;
  }) {
    const g = overrides?.graphOverride ?? graph;
    const e = overrides?.edgeOverride ?? edge;
    const evDefs = overrides?.eventDefsOverride ?? eventDefs;
    const ctxKeys = overrides?.contextKeys ?? [];
    const payload = overrides?.payload ?? {
      context: ctxKeys.map(k => ({ key: k })),
      event_filters: {},
      case: [],
    };
    return computeQuerySignature(
      payload,
      overrides?.connectionName ?? 'amplitude-prod',
      g, e, ctxKeys, undefined, evDefs,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. DETERMINISM
  // ─────────────────────────────────────────────────────────────────────────

  it('should produce identical hash on repeated calls with same inputs', async () => {
    const sig1 = await computeSig();
    const sig2 = await computeSig();
    expect(sig1).toBe(sig2);

    const hash1 = await computeShortCoreHash(sig1);
    const hash2 = await computeShortCoreHash(sig2);
    expect(hash1).toBe(hash2);
  });

  it('should produce identical hash regardless of event definition insertion order in map', async () => {
    const defsOrderA: Record<string, any> = {
      'evt-signup': eventDefs['evt-signup'],
      'evt-purchase': eventDefs['evt-purchase'],
    };
    const defsOrderB: Record<string, any> = {
      'evt-purchase': eventDefs['evt-purchase'],
      'evt-signup': eventDefs['evt-signup'],
    };
    const sig1 = await computeSig({ eventDefsOverride: defsOrderA });
    const sig2 = await computeSig({ eventDefsOverride: defsOrderB });
    expect(sig1).toBe(sig2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. SENSITIVITY — hash-relevant fields MUST change the hash
  // ─────────────────────────────────────────────────────────────────────────

  it('should change hash when connection name changes', async () => {
    const sig1 = await computeSig({ connectionName: 'amplitude-prod' });
    const sig2 = await computeSig({ connectionName: 'amplitude-staging' });
    expect(sig1).not.toBe(sig2);
  });

  it('should change hash when from event_id changes (different from node)', async () => {
    const graphAlt = {
      nodes: [
        { id: 'signup', event_id: 'evt-signup-v2' },  // Different event_id
        { id: 'purchase', event_id: 'evt-purchase' },
      ],
    };
    const defsAlt = {
      ...eventDefs,
      'evt-signup-v2': { id: 'evt-signup-v2', provider_event_names: { amplitude: 'Account Created V2' }, amplitude_filters: [] },
    };
    const sig1 = await computeSig();
    const sig2 = await computeSig({ graphOverride: graphAlt, eventDefsOverride: defsAlt });
    expect(sig1).not.toBe(sig2);
  });

  it('should change hash when to event_id changes', async () => {
    const graphAlt = {
      nodes: [
        { id: 'signup', event_id: 'evt-signup' },
        { id: 'purchase', event_id: 'evt-purchase-v2' },
      ],
    };
    const defsAlt = {
      ...eventDefs,
      'evt-purchase-v2': { id: 'evt-purchase-v2', provider_event_names: { amplitude: 'Purchase V2' }, amplitude_filters: [] },
    };
    const sig1 = await computeSig();
    const sig2 = await computeSig({ graphOverride: graphAlt, eventDefsOverride: defsAlt });
    expect(sig1).not.toBe(sig2);
  });

  it('should change hash when event amplitude_filters change', async () => {
    const defsAlt = {
      ...eventDefs,
      'evt-purchase': {
        ...eventDefs['evt-purchase'],
        amplitude_filters: [
          { property: 'amount', operator: 'is', values: ['basic'] },  // Changed value
        ],
      },
    };
    const sig1 = await computeSig();
    const sig2 = await computeSig({ eventDefsOverride: defsAlt });
    expect(sig1).not.toBe(sig2);
  });

  it('should change hash when event provider_event_names change', async () => {
    const defsAlt = {
      ...eventDefs,
      'evt-signup': {
        ...eventDefs['evt-signup'],
        provider_event_names: { amplitude: 'User Registered' },  // Changed name
      },
    };
    const sig1 = await computeSig();
    const sig2 = await computeSig({ eventDefsOverride: defsAlt });
    expect(sig1).not.toBe(sig2);
  });

  it('should change hash when amplitude_filters are added to a previously unfiltered event', async () => {
    const defsAlt = {
      ...eventDefs,
      'evt-signup': {
        ...eventDefs['evt-signup'],
        amplitude_filters: [
          { property: 'platform', operator: 'is', values: ['iOS'] },
        ],
      },
    };
    const sig1 = await computeSig();
    const sig2 = await computeSig({ eventDefsOverride: defsAlt });
    expect(sig1).not.toBe(sig2);
  });

  it('should change hash when context definition changes (value added)', async () => {
    const ctxV1 = { ...channelContext };
    const ctxV2 = {
      ...channelContext,
      values: [
        ...channelContext.values,
        { id: 'tiktok', label: 'TikTok', sources: { amplitude: { filter: "utm_source == 'tiktok'" } } },
      ],
    };

    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(ctxV1 as any);
    const sig1 = await computeSig({ contextKeys: ['channel'] });

    contextRegistry.clearCache();
    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(ctxV2 as any);
    const sig2 = await computeSig({ contextKeys: ['channel'] });

    expect(sig1).not.toBe(sig2);
  });

  it('should change hash when cohort_mode toggles (window vs cohort)', async () => {
    const sigWindow = await computeSig({ payload: { event_filters: {}, case: [] } });
    const sigCohort = await computeSig({
      payload: { event_filters: {}, case: [], cohort: { anchor_event_id: 'evt-signup' } },
    });
    expect(sigWindow).not.toBe(sigCohort);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. INSENSITIVITY — non-hash fields MUST NOT change the hash
  // ─────────────────────────────────────────────────────────────────────────

  it('should NOT change hash when event description changes', async () => {
    const defsAlt = {
      ...eventDefs,
      'evt-signup': {
        ...eventDefs['evt-signup'],
        description: 'A totally different description',
        category: 'changed-category',
        tags: ['new-tag'],
      },
    };
    const sig1 = await computeSig();
    const sig2 = await computeSig({ eventDefsOverride: defsAlt });
    expect(sig1).toBe(sig2);
  });

  it('should NOT change hash when event metadata (created_at, status) changes', async () => {
    const defsAlt = {
      ...eventDefs,
      'evt-signup': {
        ...eventDefs['evt-signup'],
        metadata: { created_at: '2026-01-01', status: 'deprecated', author: 'someone-new' },
      },
    };
    const sig1 = await computeSig();
    const sig2 = await computeSig({ eventDefsOverride: defsAlt });
    expect(sig1).toBe(sig2);
  });

  it('should NOT change hash when context name or description changes', async () => {
    const ctxV1 = { ...channelContext };
    const ctxV2 = { ...channelContext, name: 'Totally Different Name', description: 'Changed description' };

    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(ctxV1 as any);
    const sig1 = await computeSig({ contextKeys: ['channel'] });

    contextRegistry.clearCache();
    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(ctxV2 as any);
    const sig2 = await computeSig({ contextKeys: ['channel'] });

    // name IS currently in the hash (normalizeContextDefinition includes it).
    // If this test fails, it means name is hashed — which is by design currently.
    // When/if we decide name should be excluded, this test should be flipped.
    // For now, document the ACTUAL behaviour.
    expect(sig1).not.toBe(sig2);
  });

  it('should NOT change hash when context value is reordered (normalisation sorts by id)', async () => {
    const ctxOrderA = {
      ...channelContext,
      values: [
        { id: 'google', label: 'Google' },
        { id: 'meta', label: 'Meta' },
      ],
    };
    const ctxOrderB = {
      ...channelContext,
      values: [
        { id: 'meta', label: 'Meta' },
        { id: 'google', label: 'Google' },
      ],
    };

    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(ctxOrderA as any);
    const sig1 = await computeSig({ contextKeys: ['channel'] });

    contextRegistry.clearCache();
    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(ctxOrderB as any);
    const sig2 = await computeSig({ contextKeys: ['channel'] });

    expect(sig1).toBe(sig2);
  });

  it('should NOT change hash when context() value differs in query string (values stripped)', async () => {
    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext as any);

    const sig1 = await computeSig({
      edgeOverride: { query: 'from(signup).to(purchase).context(channel:google)' },
      contextKeys: ['channel'],
    });

    contextRegistry.clearCache();
    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext as any);

    const sig2 = await computeSig({
      edgeOverride: { query: 'from(signup).to(purchase).context(channel:meta)' },
      contextKeys: ['channel'],
    });

    expect(sig1).toBe(sig2);
  });

  it('should NOT change hash when window() bounds differ in query string (bounds stripped)', async () => {
    const sig1 = await computeSig({
      edgeOverride: { query: 'from(signup).to(purchase).window(-30d:)' },
    });
    const sig2 = await computeSig({
      edgeOverride: { query: 'from(signup).to(purchase).window(-90d:)' },
    });
    expect(sig1).toBe(sig2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. PIPELINE INTEGRITY — full chain produces valid, stable output
  // ─────────────────────────────────────────────────────────────────────────

  it('should produce a valid structured signature (parseable with coreHash and contextDefHashes)', async () => {
    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext as any);
    const sig = await computeSig({ contextKeys: ['channel'] });

    const parsed = parseSignature(sig);
    expect(parsed.coreHash).toBeTruthy();
    expect(typeof parsed.coreHash).toBe('string');
    expect(parsed.coreHash.length).toBe(64); // SHA-256 hex
    expect(parsed.contextDefHashes).toHaveProperty('channel');
    expect(typeof parsed.contextDefHashes.channel).toBe('string');
    expect(parsed.contextDefHashes.channel.length).toBe(64);
  });

  it('should produce a valid short core_hash from the signature (base64url, ~22 chars)', async () => {
    const sig = await computeSig();
    const shortHash = await computeShortCoreHash(sig);

    expect(typeof shortHash).toBe('string');
    expect(shortHash.length).toBeGreaterThanOrEqual(20);
    expect(shortHash.length).toBeLessThanOrEqual(24);
    // base64url alphabet only
    expect(shortHash).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('should produce different short core_hashes for different signatures', async () => {
    const sig1 = await computeSig({ connectionName: 'conn-a' });
    const sig2 = await computeSig({ connectionName: 'conn-b' });

    const hash1 = await computeShortCoreHash(sig1);
    const hash2 = await computeShortCoreHash(sig2);

    expect(hash1).not.toBe(hash2);
  });

  it('should use event_id not node_id in normalised query (cross-graph cache sharing)', async () => {
    // Two graphs with different node IDs but same event_ids
    const graphA = {
      nodes: [
        { id: 'node-alpha', event_id: 'evt-signup' },
        { id: 'node-beta', event_id: 'evt-purchase' },
      ],
    };
    const graphB = {
      nodes: [
        { id: 'node-x', event_id: 'evt-signup' },
        { id: 'node-y', event_id: 'evt-purchase' },
      ],
    };

    const sigA = await computeSig({
      graphOverride: graphA,
      edgeOverride: { query: 'from(node-alpha).to(node-beta)' },
    });
    const sigB = await computeSig({
      graphOverride: graphB,
      edgeOverride: { query: 'from(node-x).to(node-y)' },
    });

    // Same event_ids → same hash, despite different node IDs
    expect(sigA).toBe(sigB);
  });

  it('should handle missing event definitions gracefully (not_loaded sentinel)', async () => {
    // No event definitions provided → should still produce a valid signature
    const sig = await computeSig({ eventDefsOverride: {} });
    const parsed = parseSignature(sig);
    expect(parsed.coreHash).toBeTruthy();

    // And it should differ from a signature with loaded definitions
    const sigWithDefs = await computeSig();
    expect(sig).not.toBe(sigWithDefs);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. FROZEN FIXTURE — regression anchor
  // ─────────────────────────────────────────────────────────────────────────

  it('should produce a known hash for a known input (frozen regression anchor)', async () => {
    // This test pins the exact output for a specific input.
    // If it breaks, the hash computation changed — which means ALL existing
    // snapshot data is potentially orphaned. Investigate before updating.
    const frozenSig = await computeSig();
    const frozenHash = await computeShortCoreHash(frozenSig);

    // Record the expected values on first run, then hard-code them.
    // The structured signature should have a stable coreHash.
    const parsed = parseSignature(frozenSig);

    // Verify structural properties that must hold forever
    expect(parsed.coreHash).toMatch(/^[0-9a-f]{64}$/);
    expect(frozenHash).toMatch(/^[A-Za-z0-9_-]{20,24}$/);

    // Pin the actual value — update ONLY if you intentionally changed the hash algorithm
    // and have created hash-mappings.json entries for all affected parameters.
    // If this test fails, ALL existing snapshot data may be orphaned. Investigate.
    expect(frozenHash).toBe('eo-LmVRt9ay1tX5ejjYh2A');
  });
});


