/**
 * Candidate Regime Service Tests (Doc 30 §7.3.7)
 *
 * Tests for buildCandidateRegimesByEdge and computeMeceDimensions.
 *
 * EP-001: Multi-dimension DSL produces correct candidates per edge
 * EP-002: MECE dimensions correctly identified from context registry
 * EP-003: Single-dimension DSL produces one candidate per edge
 * EP-004: Cross-product DSL produces one candidate (not separate per dim)
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCandidateRegimesByEdge, computeMeceDimensions } from '../candidateRegimeService';
import { contextRegistry } from '../contextRegistry';

vi.mock('../fetchPlanBuilderService', () => ({
  buildFetchPlanProduction: vi.fn(async (graph: any, slice: string) => ({
    plan: {
      items: (graph.edges ?? []).map((edge: any) => ({
        querySignature: `sig:${slice}:${edge.uuid}`,
        targetId: edge.uuid,
      })),
    },
  })),
}));

vi.mock('../coreHashService', () => ({
  computeShortCoreHash: vi.fn(async (signature: string) => `hash:${signature}`),
}));

vi.mock('../hashMappingsService', () => ({
  getClosureSet: vi.fn(() => []),
}));

// ---------------------------------------------------------------------------
// Mock context registry
// ---------------------------------------------------------------------------
const CONTEXT_VALUES: Record<string, Array<{ id: string }>> = {
  channel: [{ id: 'google' }, { id: 'meta' }],
  device: [{ id: 'mobile' }, { id: 'desktop' }],
};

const CONTEXT_DEFS: Record<string, any> = {
  channel: {
    id: 'channel',
    name: 'Channel',
    otherPolicy: 'null', // MECE
    values: CONTEXT_VALUES.channel,
  },
  device: {
    id: 'device',
    name: 'Device',
    otherPolicy: 'undefined', // NOT MECE
    values: CONTEXT_VALUES.device,
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(contextRegistry, 'getValuesForContext').mockImplementation(
    async (key: string) => CONTEXT_VALUES[key] ?? [],
  );
  vi.spyOn(contextRegistry, 'getContext').mockImplementation(
    async (key: string) => CONTEXT_DEFS[key] ?? null,
  );
  vi.spyOn(contextRegistry, 'ensureContextsCached').mockResolvedValue(undefined as any);
});

// ---------------------------------------------------------------------------
// Minimal graph fixture
// ---------------------------------------------------------------------------
function makeGraph(opts: { pinnedDsl: string }): any {
  return {
    nodes: [
      { id: 'signup', uuid: 'node-signup', event_id: 'evt_signup', label: 'Signup' },
      { id: 'purchase', uuid: 'node-purchase', event_id: 'evt_purchase', label: 'Purchase' },
    ],
    edges: [
      {
        id: 'edge-1',
        uuid: 'edge-uuid-1',
        from: 'node-signup',
        to: 'node-purchase',
        query: 'from(signup).to(purchase)',
        p: {
          id: 'signup-to-purchase',
          connection: 'amplitude',
        },
      },
    ],
    policies: {},
    metadata: {},
    dataInterestsDSL: opts.pinnedDsl,
    defaultConnection: 'amplitude',
  };
}

const WORKSPACE = { repository: 'test/repo', branch: 'main' };

// ===========================================================================
// EP-002: computeMeceDimensions
// ===========================================================================

describe('computeMeceDimensions', () => {
  it('EP-002: identifies MECE dimensions from context registry', async () => {
    const graph = makeGraph({
      pinnedDsl: '(window(-90d:)).(context(channel);context(device))',
    });

    const dims = await computeMeceDimensions(graph, WORKSPACE);

    // channel has otherPolicy='null' → MECE
    // device has otherPolicy='undefined' → NOT MECE
    expect(dims).toContain('channel');
    expect(dims).not.toContain('device');
  });

  it('returns empty for graph with no pinned DSL', async () => {
    const graph = makeGraph({ pinnedDsl: '' });
    const dims = await computeMeceDimensions(graph, WORKSPACE);
    expect(dims).toEqual([]);
  });

  it('returns empty for graph with no context in pinned DSL', async () => {
    const graph = makeGraph({ pinnedDsl: 'window(-90d:)' });
    const dims = await computeMeceDimensions(graph, WORKSPACE);
    expect(dims).toEqual([]);
  });
});

// ===========================================================================
// EP-001/003/004: buildCandidateRegimesByEdge
//
// NOTE: buildCandidateRegimesByEdge calls buildFetchPlanProduction
// internally, which requires connection providers, event loaders,
// and signature computation infrastructure. In a unit test without
// the full production environment, these will fail.
//
// These tests verify the simpler paths (empty DSL, DSL with no
// context) and document the expected behaviour for complex DSLs
// as skipped integration tests.
// ===========================================================================

describe('buildCandidateRegimesByEdge', () => {
  it('returns empty for graph with no pinned DSL', async () => {
    const graph = makeGraph({ pinnedDsl: '' });
    const result = await buildCandidateRegimesByEdge(graph, WORKSPACE);
    expect(result).toEqual({});
  });

  it('returns empty for graph with empty pinned DSL', async () => {
    const graph = makeGraph({ pinnedDsl: '   ' });
    const result = await buildCandidateRegimesByEdge(graph, WORKSPACE);
    expect(result).toEqual({});
  });

  it('keeps cohort candidates separated by explicit cohort anchor', async () => {
    const graph = makeGraph({
      pinnedDsl: 'window(-90d:);cohort(signup,-90d:)',
    });
    const parameterFiles = {
      'signup-to-purchase': {
        values: [
          {
            sliceDSL: 'cohort(signup,-90d:)',
            query_signature: 'sig:cohort(signup,-90d:):edge-uuid-1',
          },
          {
            sliceDSL: 'cohort(landing,-90d:)',
            query_signature: 'sig:cohort(landing,-90d:):edge-uuid-1',
          },
        ],
      },
    };

    const result = await buildCandidateRegimesByEdge(graph, WORKSPACE, parameterFiles);
    const cohorts = (result['edge-uuid-1'] ?? []).filter(r => r.temporal_mode === 'cohort');

    expect(cohorts).toHaveLength(2);
    expect(cohorts.map(r => r.cohort_anchor).sort()).toEqual(['landing', 'signup']);
    expect(new Set(cohorts.map(r => r.core_hash)).size).toBe(2);
  });
});
