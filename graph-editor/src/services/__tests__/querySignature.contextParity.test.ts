/**
 * Doc 43b — Context hash parity verification.
 *
 * Verifies that computeQuerySignature produces DIFFERENT structured
 * signatures (and therefore different core_hash values) when called
 * with vs without context keys.
 *
 * This is an integration test that exercises the real signature
 * computation pipeline with a mocked contextRegistry.
 *
 * What real bug would this test catch?
 *   - Context keys passed but ignored (contextDefHashes always {})
 *   - Context keys extracted from graph config instead of DSL
 *   - contextRegistry.getContext returning undefined → contextDefHashes
 *     still differs from {} (has "missing" entry), but core_hash differs
 *   - Structured signature serialisation ignoring x field
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeQuerySignature } from '../dataOperations/querySignature';
import { computeShortCoreHash } from '../coreHashService';
import { contextRegistry } from '../contextRegistry';

// Minimal graph with one edge
const GRAPH = {
  nodes: [
    { id: 'node-a', uuid: 'uuid-a', event_id: 'evt-homepage' },
    { id: 'node-b', uuid: 'uuid-b', event_id: 'evt-checkout' },
  ],
  edges: [
    {
      uuid: 'edge-1',
      query: 'from(node-a).to(node-b)',
      p: { id: 'param-a-b', connection: 'amplitude' },
    },
  ],
};

const EDGE = GRAPH.edges[0];

const EVENT_DEFINITIONS = {
  'evt-homepage': {
    id: 'evt-homepage',
    provider_event_names: { amplitude: 'Homepage View' },
    amplitude_filters: [],
  },
  'evt-checkout': {
    id: 'evt-checkout',
    provider_event_names: { amplitude: 'Checkout Complete' },
    amplitude_filters: [],
  },
};

const SYNTH_CHANNEL_CONTEXT = {
  id: 'synth-channel',
  name: 'Synth Channel',
  description: 'Test context dimension',
  type: 'categorical' as const,
  otherPolicy: 'null' as const,
  values: [
    { id: 'google', label: 'Google', sources: { amplitude: { field: 'utm_source', filter: "utm_source == 'google'" } } },
  ],
  metadata: { created_at: '2025-01-01', version: '1', status: 'active' as const },
};

// Minimal query payload (no context in the payload itself —
// context comes from the contextKeys parameter)
const BASE_PAYLOAD = {
  from_event: 'evt-homepage',
  to_event: 'evt-checkout',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('doc 43b: bare vs contexted signature parity', () => {
  it('contextKeys=[] and contextKeys=["synth-channel"] produce different signatures', async () => {
    // Mock contextRegistry to return the synth-channel context
    vi.spyOn(contextRegistry, 'getContext').mockImplementation(
      async (id: string) => id === 'synth-channel' ? SYNTH_CHANNEL_CONTEXT : undefined,
    );

    const bareSig = await computeQuerySignature(
      BASE_PAYLOAD,
      'amplitude',
      GRAPH as any,
      EDGE,
      [],  // NO context keys
      undefined,
      EVENT_DEFINITIONS,
    );

    const ctxSig = await computeQuerySignature(
      BASE_PAYLOAD,
      'amplitude',
      GRAPH as any,
      EDGE,
      ['synth-channel'],  // WITH context key
      undefined,
      EVENT_DEFINITIONS,
    );

    // Signatures must be different strings
    expect(bareSig).not.toBe(ctxSig);

    // Both must be valid structured signatures (JSON with c and x)
    const bareParsed = JSON.parse(bareSig);
    const ctxParsed = JSON.parse(ctxSig);

    // Same identity hash (same edge topology)
    expect(bareParsed.c).toBe(ctxParsed.c);

    // Different x (context def hashes)
    expect(bareParsed.x).toEqual({});
    expect(ctxParsed.x).toHaveProperty('synth-channel');
    expect(ctxParsed.x['synth-channel']).not.toBe('');

    // Different core_hash
    const bareCoreHash = await computeShortCoreHash(bareSig);
    const ctxCoreHash = await computeShortCoreHash(ctxSig);
    expect(bareCoreHash).not.toBe(ctxCoreHash);
  });

  it('contextKeys=["synth-channel"] with missing registry entry still differs from bare', async () => {
    // contextRegistry returns undefined for synth-channel → should get "missing"
    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(undefined);

    const bareSig = await computeQuerySignature(
      BASE_PAYLOAD, 'amplitude', GRAPH as any, EDGE, [],
      undefined, EVENT_DEFINITIONS,
    );

    const ctxSig = await computeQuerySignature(
      BASE_PAYLOAD, 'amplitude', GRAPH as any, EDGE, ['synth-channel'],
      undefined, EVENT_DEFINITIONS,
    );

    const bareParsed = JSON.parse(bareSig);
    const ctxParsed = JSON.parse(ctxSig);

    expect(bareParsed.x).toEqual({});
    expect(ctxParsed.x).toEqual({ 'synth-channel': 'missing' });
    expect(bareSig).not.toBe(ctxSig);
  });

  it('extractContextKeysFromConstraints extracts bare key from context(synth-channel)', async () => {
    const { parseConstraints } = await import('../../lib/queryDSL');
    const { extractContextKeysFromConstraints } = await import('../dataOperations/querySignature');

    const bare = parseConstraints('window(12-Dec-25:11-Mar-26)');
    const ctx = parseConstraints('context(synth-channel).window(12-Dec-25:11-Mar-26)');

    const bareKeys = extractContextKeysFromConstraints(bare);
    const ctxKeys = extractContextKeysFromConstraints(ctx);

    expect(bareKeys).toEqual([]);
    expect(ctxKeys).toEqual(['synth-channel']);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline test: computePlannerQuerySignaturesForGraph
//
// This exercises the same code path as bayes.ts → buildFetchPlanProduction
// → computePlannerQuerySignaturesForGraph. If the context keys get lost
// anywhere in this chain, this test catches it.
// ---------------------------------------------------------------------------

describe('doc 43b: computePlannerQuerySignaturesForGraph bare vs contexted', () => {
  it('bare DSL and contexted DSL produce different signatures for the same edge', async () => {
    // Mock contextRegistry
    vi.spyOn(contextRegistry, 'getContext').mockImplementation(
      async (id: string) => id === 'synth-channel' ? SYNTH_CHANNEL_CONTEXT : undefined,
    );

    // Seed fileRegistry with events and parameter file
    const { fileRegistry } = await import('../../contexts/TabContext');
    const source = { repository: 'cli', branch: 'local', path: '' };
    fileRegistry.seedFileInMemory('event-evt-homepage', 'event', EVENT_DEFINITIONS['evt-homepage'], source);
    fileRegistry.seedFileInMemory('event-evt-checkout', 'event', EVENT_DEFINITIONS['evt-checkout'], source);
    fileRegistry.seedFileInMemory('parameter-param-a-b', 'parameter', { id: 'param-a-b', values: [] }, source);
    fileRegistry.seedFileInMemory('connections-connections', 'connections', {
      connections: [{ name: 'amplitude', provider: 'amplitude' }],
    }, source);

    const { computePlannerQuerySignaturesForGraph } = await import('../plannerQuerySignatureService');

    const bareDsl = 'window(12-Dec-25:11-Mar-26)';
    const ctxDsl = 'context(synth-channel).window(12-Dec-25:11-Mar-26)';

    const bareSigs = await computePlannerQuerySignaturesForGraph({
      graph: GRAPH as any,
      dsl: bareDsl,
      forceCompute: true,
    });

    const ctxSigs = await computePlannerQuerySignaturesForGraph({
      graph: GRAPH as any,
      dsl: ctxDsl,
      forceCompute: true,
    });

    // Both should produce signatures for the same edge
    const bareKeys = Object.keys(bareSigs);
    const ctxKeys = Object.keys(ctxSigs);
    expect(bareKeys.length).toBeGreaterThan(0);
    expect(ctxKeys.length).toBeGreaterThan(0);

    // The signatures must differ
    // Find a common key (same param/edge) and compare
    const commonKey = bareKeys.find(k => ctxKeys.includes(k));
    if (commonKey) {
      const bareSig = bareSigs[commonKey];
      const ctxSig = ctxSigs[commonKey];
      expect(bareSig).not.toBe(ctxSig);

      // Parse and verify x field differs
      const bareParsed = JSON.parse(bareSig);
      const ctxParsed = JSON.parse(ctxSig);
      expect(bareParsed.x).toEqual({});
      expect(Object.keys(ctxParsed.x).length).toBeGreaterThan(0);
    } else {
      // If no common key, at least verify both have entries
      // and log what happened for diagnosis
      const msg = `No common signature key.\n  bare keys: ${JSON.stringify(bareKeys)}\n  ctx keys: ${JSON.stringify(ctxKeys)}`;
      expect.fail(msg);
    }
  });
});
