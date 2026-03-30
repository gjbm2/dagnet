/**
 * Commit Hash Guard — Integration Tests
 *
 * Tests the commit-time hash guard that detects when event/context file edits
 * change snapshot hashes, and offers to create hash-mappings.json entries to
 * preserve historical data.
 *
 * Written BLIND from the specification — no implementation code was read.
 *
 * Mock decisions:
 *   - IDB (fake-indexeddb): REAL — the service reads graphs, events, contexts,
 *     and parameters from IDB. Bugs at the IDB boundary are the main risk.
 *   - contextRegistry: REAL service, but getContext is spied to provide
 *     controlled context definitions for deterministic hashing.
 *   - computeQuerySignature / computeShortCoreHash: REAL production code.
 *     We use them to pre-compute the "stored" signatures so assertions can
 *     verify the guard produces genuinely different old vs new hashes.
 *   - getOldFileContent callback: MOCKED — represents a git API call.
 *   - fileRegistry: MOCKED minimally — the service primarily reads from IDB,
 *     but may fall back to fileRegistry for event/context resolution.
 *
 * Run with:
 *   cd graph-editor && npm test -- --run src/services/__tests__/commitHashGuard.integration.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

import { db } from '../../db/appDatabase';
import { commitHashGuardService } from '../commitHashGuardService';
import { computeQuerySignature } from '../dataOperations/querySignature';
import { computeShortCoreHash } from '../coreHashService';
import { parseSignature } from '../signatureMatchingService';
import { contextRegistry } from '../contextRegistry';

// ---------------------------------------------------------------------------
// Mock fileRegistry — the service may read event/context files via registry
// as a fast-path. We provide a minimal mock so it falls back to IDB.
// ---------------------------------------------------------------------------
vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    getFile: vi.fn().mockReturnValue(null),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE = { repository: 'test-repo', branch: 'main' };

/** Minimal graph with nodes that have event_ids, edges with queries and param IDs. */
function makeGraph(opts: {
  nodes: Array<{ id: string; uuid: string; event_id: string }>;
  edges: Array<{ uuid: string; from: string; to: string; query: string; paramId: string; connection?: string }>;
  metadata?: { name?: string };
  dataInterestsDSL?: string;
}) {
  return {
    nodes: opts.nodes.map((n) => ({
      ...n,
      entry: n.id === opts.nodes[0]?.id ? { is_start: true, entry_weight: 1 } : undefined,
    })),
    edges: opts.edges.map((e) => ({
      uuid: e.uuid,
      id: `${e.from}-${e.to}`,
      from: e.from,
      to: e.to,
      query: e.query,
      p: {
        id: e.paramId,
        mean: 0.5,
        connection: e.connection || 'amplitude-prod',
      },
    })),
    policies: {},
    metadata: opts.metadata || { name: 'Test Graph' },
    dataInterestsDSL: opts.dataInterestsDSL,
  };
}

/** Create an event file data object. */
function makeEventData(eventId: string, overrides?: Partial<{
  provider_event_names: Record<string, string[]>;
  amplitude_filters: any[];
  description: string;
}>) {
  return {
    id: eventId,
    name: eventId,
    description: overrides?.description || `Event ${eventId}`,
    provider_event_names: overrides?.provider_event_names || {
      amplitude: [`amp_${eventId}`],
    },
    amplitude_filters: overrides?.amplitude_filters || [],
  };
}

/** Create a context file data object. */
function makeContextData(contextId: string, overrides?: Partial<{
  values: Array<{ id: string; label: string }>;
  description: string;
}>) {
  return {
    id: contextId,
    name: contextId,
    description: overrides?.description || `Context ${contextId}`,
    type: 'categorical',
    otherPolicy: 'null',
    values: overrides?.values || [
      { id: 'val-1', label: 'Value 1' },
      { id: 'val-2', label: 'Value 2' },
    ],
    metadata: {
      category: 'test',
      data_source: 'manual',
      created_at: '1-Jan-25',
      version: '1.0',
      status: 'active',
    },
  };
}

/**
 * Compute a query_signature for a given graph + edge + event definitions,
 * using the real computeQuerySignature function. This allows us to seed
 * parameter files with realistic stored signatures.
 */
async function computeSignatureForEdge(
  graph: any,
  edge: any,
  eventDefinitions: Record<string, any>,
  connectionName: string = 'amplitude-prod',
): Promise<string> {
  return computeQuerySignature(
    { event_filters: {} },
    connectionName,
    graph,
    edge,
    [],  // no context keys for base computation
    WORKSPACE,
    eventDefinitions,
  );
}

/** Seed a graph file into IDB. */
async function seedGraph(graphFileId: string, graphData: any) {
  await db.files.put({
    fileId: graphFileId,
    type: 'graph',
    path: `graphs/${graphFileId}.json`,
    data: graphData,
    originalData: structuredClone(graphData),
    isDirty: false,
    viewTabs: [],
    lastModified: Date.now(),
    source: { repository: WORKSPACE.repository, branch: WORKSPACE.branch, path: `graphs/${graphFileId}.json` },
  });
}

/** Seed an event file into IDB. */
async function seedEvent(eventId: string, data: any) {
  await db.files.put({
    fileId: `event-${eventId}`,
    type: 'event',
    path: `events/${eventId}.yaml`,
    data,
    originalData: structuredClone(data),
    isDirty: true,
    viewTabs: [],
    lastModified: Date.now(),
    source: { repository: WORKSPACE.repository, branch: WORKSPACE.branch, path: `events/${eventId}.yaml` },
  });
}

/** Seed a context file into IDB. */
async function seedContext(contextId: string, data: any) {
  await db.files.put({
    fileId: `context-${contextId}`,
    type: 'context',
    path: `contexts/${contextId}.yaml`,
    data,
    originalData: structuredClone(data),
    isDirty: true,
    viewTabs: [],
    lastModified: Date.now(),
    source: { repository: WORKSPACE.repository, branch: WORKSPACE.branch, path: `contexts/${contextId}.yaml` },
  });
}

/** Seed a parameter file into IDB with a stored query_signature. */
async function seedParameter(paramId: string, querySignature: string, graphFileId: string) {
  await db.files.put({
    fileId: `parameter-${paramId}`,
    type: 'parameter',
    path: `parameters/${paramId}.yaml`,
    data: {
      id: paramId,
      name: paramId,
      type: 'probability',
      values: [
        {
          mean: 0.5,
          stdev: 0.1,
          n: 100,
          k: 50,
          query_signature: querySignature,
        },
      ],
      metadata: {
        description: `Parameter ${paramId}`,
      },
    },
    originalData: null,
    isDirty: false,
    viewTabs: [],
    lastModified: Date.now(),
    source: { repository: WORKSPACE.repository, branch: WORKSPACE.branch, path: `parameters/${paramId}.yaml` },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('commitHashGuardService — detectHashChanges', () => {
  beforeEach(async () => {
    await db.files.clear();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Scenario 1: No event/context files in changeset → returns null
  // =========================================================================
  it('should return null when changeset contains no event or context files', async () => {
    // Seed a graph and parameter — but only commit a graph file
    const graphData = makeGraph({
      nodes: [
        { id: 'nodeA', uuid: 'nodeA', event_id: 'evt-signup' },
        { id: 'nodeB', uuid: 'nodeB', event_id: 'evt-purchase' },
      ],
      edges: [
        { uuid: 'e1', from: 'nodeA', to: 'nodeB', query: 'from(nodeA).to(nodeB)', paramId: 'param-ab' },
      ],
    });
    await seedGraph('graph-test', graphData);

    const committedFiles = [
      {
        fileId: 'graph-test',
        type: 'graph',
        data: graphData,
        source: { path: 'graphs/graph-test.json' },
      },
    ];

    const getOldFileContent = vi.fn().mockResolvedValue(null);
    const result = await commitHashGuardService.detectHashChanges(committedFiles, getOldFileContent, WORKSPACE);

    expect(result).toBeNull();
    // Should not even call getOldFileContent since no event/context files
    expect(getOldFileContent).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Scenario 2: Event file changed but content identical → returns null
  // =========================================================================
  it('should return null when event file content is identical to git HEAD version', async () => {
    const eventData = makeEventData('evt-signup');
    await seedEvent('evt-signup', eventData);

    const committedFiles = [
      {
        fileId: 'event-evt-signup',
        type: 'event',
        data: eventData,
        source: { path: 'events/evt-signup.yaml' },
      },
    ];

    // Old content is identical
    const getOldFileContent = vi.fn().mockResolvedValue(structuredClone(eventData));
    const result = await commitHashGuardService.detectHashChanges(committedFiles, getOldFileContent, WORKSPACE);

    expect(result).toBeNull();
  });

  // =========================================================================
  // Scenario 3: New event file (no git HEAD version) → returns null
  // =========================================================================
  it('should return null when event file is new (no previous version in git)', async () => {
    const eventData = makeEventData('evt-brand-new');
    await seedEvent('evt-brand-new', eventData);

    const graphData = makeGraph({
      nodes: [
        { id: 'nodeA', uuid: 'nodeA', event_id: 'evt-brand-new' },
        { id: 'nodeB', uuid: 'nodeB', event_id: 'evt-other' },
      ],
      edges: [
        { uuid: 'e1', from: 'nodeA', to: 'nodeB', query: 'from(nodeA).to(nodeB)', paramId: 'param-ab' },
      ],
    });
    await seedGraph('graph-new', graphData);

    const committedFiles = [
      {
        fileId: 'event-evt-brand-new',
        type: 'event',
        data: eventData,
        source: { path: 'events/evt-brand-new.yaml' },
      },
    ];

    // getOldFileContent returns null — file doesn't exist in git HEAD
    const getOldFileContent = vi.fn().mockResolvedValue(null);
    const result = await commitHashGuardService.detectHashChanges(committedFiles, getOldFileContent, WORKSPACE);

    expect(result).toBeNull();
  });

  // =========================================================================
  // Scenario 4: Event file with changed amplitude_filters → detects affected
  //             parameters in the correct graph(s)
  // =========================================================================
  it('should detect hash changes when event amplitude_filters change', async () => {
    // Build the old event definition (no filters)
    const oldEventData = makeEventData('evt-signup', {
      amplitude_filters: [],
    });

    // Build the new event definition (filters added)
    const newEventData = makeEventData('evt-signup', {
      amplitude_filters: [
        { subprop_key: 'platform', subprop_op: 'is', subprop_value: ['iOS'] },
      ],
    });

    // Build graph with nodes referencing this event
    const graphData = makeGraph({
      nodes: [
        { id: 'nodeA', uuid: 'nodeA', event_id: 'evt-signup' },
        { id: 'nodeB', uuid: 'nodeB', event_id: 'evt-purchase' },
      ],
      edges: [
        { uuid: 'e1', from: 'nodeA', to: 'nodeB', query: 'from(nodeA).to(nodeB)', paramId: 'param-signup-purchase' },
      ],
      metadata: { name: 'Signup Flow' },
    });

    await seedGraph('graph-signup', graphData);
    await seedEvent('evt-signup', newEventData);
    await seedEvent('evt-purchase', makeEventData('evt-purchase'));

    // Compute the OLD signature (what would have been stored when data was fetched with old event def)
    const oldEventDefs: Record<string, any> = {
      'evt-signup': oldEventData,
      'evt-purchase': makeEventData('evt-purchase'),
    };
    const edge = graphData.edges[0];
    const oldSignature = await computeSignatureForEdge(graphData, edge, oldEventDefs);

    // Seed parameter with OLD signature
    await seedParameter('param-signup-purchase', oldSignature, 'graph-signup');

    const committedFiles = [
      {
        fileId: 'event-evt-signup',
        type: 'event',
        data: newEventData,
        source: { path: 'events/evt-signup.yaml' },
      },
    ];

    const getOldFileContent = vi.fn().mockResolvedValue(oldEventData);

    const result = await commitHashGuardService.detectHashChanges(committedFiles, getOldFileContent, WORKSPACE);

    // Should detect a change
    expect(result).not.toBeNull();
    expect(result!.totalMappings).toBeGreaterThanOrEqual(1);
    expect(result!.changedFiles).toHaveLength(1);
    expect(result!.changedFiles[0].fileId).toBe('event-evt-signup');
    expect(result!.changedFiles[0].fileType).toBe('event');

    // Should reference the correct graph
    const graphEntry = result!.changedFiles[0].graphs.find(
      (g) => g.graphFileId === 'graph-signup',
    );
    expect(graphEntry).not.toBeUndefined();
    expect(graphEntry!.graphName).toBe('Signup Flow');

    // Should have at least one item with the correct param
    const item = graphEntry!.items.find((i) => i.paramId === 'param-signup-purchase');
    expect(item).not.toBeUndefined();
    expect(item!.changedFile).toBe('event-evt-signup');

    // Hashes should be genuinely different strings
    expect(item!.oldCoreHash).not.toBe(item!.newCoreHash);
    expect(typeof item!.oldCoreHash).toBe('string');
    expect(typeof item!.newCoreHash).toBe('string');
    expect(item!.oldCoreHash.length).toBeGreaterThan(0);
    expect(item!.newCoreHash.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // Scenario 5: Context file changed → detects ALL edges in affected graph(s)
  // =========================================================================
  it('should detect ALL edges in graphs whose dataInterestsDSL references a changed context', async () => {
    const oldContextData = makeContextData('channel', {
      values: [
        { id: 'paid', label: 'Paid' },
        { id: 'organic', label: 'Organic' },
      ],
    });

    const newContextData = makeContextData('channel', {
      values: [
        { id: 'paid', label: 'Paid' },
        { id: 'organic', label: 'Organic' },
        { id: 'referral', label: 'Referral' },  // new value added
      ],
    });

    // Spy on contextRegistry.getContext so the real computeQuerySignature
    // gets controlled context definitions
    vi.spyOn(contextRegistry, 'getContext').mockImplementation(async (key: string) => {
      if (key === 'channel') return newContextData as any;
      return null;
    });

    // Graph with dataInterestsDSL referencing 'channel' context, and TWO edges
    const graphData = makeGraph({
      nodes: [
        { id: 'nodeA', uuid: 'nodeA', event_id: 'evt-visit' },
        { id: 'nodeB', uuid: 'nodeB', event_id: 'evt-signup' },
        { id: 'nodeC', uuid: 'nodeC', event_id: 'evt-purchase' },
      ],
      edges: [
        { uuid: 'e1', from: 'nodeA', to: 'nodeB', query: 'from(nodeA).to(nodeB)', paramId: 'param-visit-signup' },
        { uuid: 'e2', from: 'nodeB', to: 'nodeC', query: 'from(nodeB).to(nodeC)', paramId: 'param-signup-purchase' },
      ],
      metadata: { name: 'Full Funnel' },
      dataInterestsDSL: 'context(channel)',
    });

    await seedGraph('graph-funnel', graphData);
    await seedContext('channel', newContextData);
    await seedEvent('evt-visit', makeEventData('evt-visit'));
    await seedEvent('evt-signup', makeEventData('evt-signup'));
    await seedEvent('evt-purchase', makeEventData('evt-purchase'));

    // Compute OLD signatures for both edges (using old context definition)
    const eventDefs: Record<string, any> = {
      'evt-visit': makeEventData('evt-visit'),
      'evt-signup': makeEventData('evt-signup'),
      'evt-purchase': makeEventData('evt-purchase'),
    };

    // For old signatures, we need old context hash — temporarily mock getContext to return old data
    const getContextSpy = vi.spyOn(contextRegistry, 'getContext').mockImplementation(async (key: string) => {
      if (key === 'channel') return oldContextData as any;
      return null;
    });

    const oldSig1 = await computeQuerySignature(
      { event_filters: {}, context: [{ key: 'channel' }] },
      'amplitude-prod',
      graphData,
      graphData.edges[0],
      ['channel'],
      WORKSPACE,
      eventDefs,
    );
    const oldSig2 = await computeQuerySignature(
      { event_filters: {}, context: [{ key: 'channel' }] },
      'amplitude-prod',
      graphData,
      graphData.edges[1],
      ['channel'],
      WORKSPACE,
      eventDefs,
    );

    // Restore spy to return new context data (what the guard will compute)
    getContextSpy.mockImplementation(async (key: string) => {
      if (key === 'channel') return newContextData as any;
      return null;
    });

    await seedParameter('param-visit-signup', oldSig1, 'graph-funnel');
    await seedParameter('param-signup-purchase', oldSig2, 'graph-funnel');

    const committedFiles = [
      {
        fileId: 'context-channel',
        type: 'context',
        data: newContextData,
        source: { path: 'contexts/channel.yaml' },
      },
    ];

    const getOldFileContent = vi.fn().mockResolvedValue(oldContextData);

    const result = await commitHashGuardService.detectHashChanges(committedFiles, getOldFileContent, WORKSPACE);

    expect(result).not.toBeNull();
    expect(result!.changedFiles).toHaveLength(1);
    expect(result!.changedFiles[0].fileType).toBe('context');

    // Context change should affect ALL edges in the graph
    const graphEntry = result!.changedFiles[0].graphs.find(
      (g) => g.graphFileId === 'graph-funnel',
    );
    expect(graphEntry).not.toBeUndefined();

    // Both parameters should be detected
    const paramIds = graphEntry!.items.map((i) => i.paramId).sort();
    expect(paramIds).toContain('param-visit-signup');
    expect(paramIds).toContain('param-signup-purchase');
    expect(result!.totalMappings).toBeGreaterThanOrEqual(2);
  });

  // =========================================================================
  // Scenario 6: Multiple changed files in one commit
  // =========================================================================
  it('should detect affected parameters across multiple changed event files', async () => {
    const oldEventA = makeEventData('evt-a', { amplitude_filters: [] });
    const newEventA = makeEventData('evt-a', {
      amplitude_filters: [{ subprop_key: 'os', subprop_op: 'is', subprop_value: ['Android'] }],
    });

    const oldEventB = makeEventData('evt-b', {
      provider_event_names: { amplitude: ['old_event_b'] },
    });
    const newEventB = makeEventData('evt-b', {
      provider_event_names: { amplitude: ['new_event_b_renamed'] },
    });

    // Two separate graphs, each referencing one of the changed events
    const graphDataA = makeGraph({
      nodes: [
        { id: 'n1', uuid: 'n1', event_id: 'evt-a' },
        { id: 'n2', uuid: 'n2', event_id: 'evt-x' },
      ],
      edges: [
        { uuid: 'ea1', from: 'n1', to: 'n2', query: 'from(n1).to(n2)', paramId: 'param-a-x' },
      ],
      metadata: { name: 'Graph A' },
    });

    const graphDataB = makeGraph({
      nodes: [
        { id: 'n3', uuid: 'n3', event_id: 'evt-b' },
        { id: 'n4', uuid: 'n4', event_id: 'evt-y' },
      ],
      edges: [
        { uuid: 'eb1', from: 'n3', to: 'n4', query: 'from(n3).to(n4)', paramId: 'param-b-y' },
      ],
      metadata: { name: 'Graph B' },
    });

    await seedGraph('graph-a', graphDataA);
    await seedGraph('graph-b', graphDataB);
    await seedEvent('evt-a', newEventA);
    await seedEvent('evt-b', newEventB);
    await seedEvent('evt-x', makeEventData('evt-x'));
    await seedEvent('evt-y', makeEventData('evt-y'));

    // Compute old signatures
    const oldSigA = await computeSignatureForEdge(
      graphDataA,
      graphDataA.edges[0],
      { 'evt-a': oldEventA, 'evt-x': makeEventData('evt-x') },
    );
    const oldSigB = await computeSignatureForEdge(
      graphDataB,
      graphDataB.edges[0],
      { 'evt-b': oldEventB, 'evt-y': makeEventData('evt-y') },
    );

    await seedParameter('param-a-x', oldSigA, 'graph-a');
    await seedParameter('param-b-y', oldSigB, 'graph-b');

    const committedFiles = [
      {
        fileId: 'event-evt-a',
        type: 'event',
        data: newEventA,
        source: { path: 'events/evt-a.yaml' },
      },
      {
        fileId: 'event-evt-b',
        type: 'event',
        data: newEventB,
        source: { path: 'events/evt-b.yaml' },
      },
    ];

    const getOldFileContent = vi.fn().mockImplementation(async (path: string) => {
      if (path.includes('evt-a')) return oldEventA;
      if (path.includes('evt-b')) return oldEventB;
      return null;
    });

    const result = await commitHashGuardService.detectHashChanges(committedFiles, getOldFileContent, WORKSPACE);

    expect(result).not.toBeNull();
    expect(result!.changedFiles).toHaveLength(2);
    expect(result!.totalMappings).toBeGreaterThanOrEqual(2);

    // Both changed event files should appear
    const fileIds = result!.changedFiles.map((f) => f.fileId).sort();
    expect(fileIds).toContain('event-evt-a');
    expect(fileIds).toContain('event-evt-b');
  });

  // =========================================================================
  // Scenario 7: Parameter with no stored query_signature → skipped
  // =========================================================================
  it('should skip parameters that have no stored query_signature', async () => {
    const oldEventData = makeEventData('evt-skip', { amplitude_filters: [] });
    const newEventData = makeEventData('evt-skip', {
      amplitude_filters: [{ subprop_key: 'device', subprop_op: 'is', subprop_value: ['tablet'] }],
    });

    const graphData = makeGraph({
      nodes: [
        { id: 'nS1', uuid: 'nS1', event_id: 'evt-skip' },
        { id: 'nS2', uuid: 'nS2', event_id: 'evt-other' },
      ],
      edges: [
        { uuid: 'es1', from: 'nS1', to: 'nS2', query: 'from(nS1).to(nS2)', paramId: 'param-no-sig' },
      ],
      metadata: { name: 'Skip Graph' },
    });

    await seedGraph('graph-skip', graphData);
    await seedEvent('evt-skip', newEventData);
    await seedEvent('evt-other', makeEventData('evt-other'));

    // Seed parameter WITHOUT a query_signature (never fetched)
    await db.files.put({
      fileId: 'parameter-param-no-sig',
      type: 'parameter',
      path: 'parameters/param-no-sig.yaml',
      data: {
        id: 'param-no-sig',
        name: 'param-no-sig',
        type: 'probability',
        values: [
          {
            mean: 0.5,
            stdev: 0.1,
            // NO query_signature field
          },
        ],
        metadata: { description: 'Unfetched parameter' },
      },
      originalData: null,
      isDirty: false,
      viewTabs: [],
      lastModified: Date.now(),
      source: { repository: WORKSPACE.repository, branch: WORKSPACE.branch, path: 'parameters/param-no-sig.yaml' },
    });

    const committedFiles = [
      {
        fileId: 'event-evt-skip',
        type: 'event',
        data: newEventData,
        source: { path: 'events/evt-skip.yaml' },
      },
    ];

    const getOldFileContent = vi.fn().mockResolvedValue(oldEventData);

    const result = await commitHashGuardService.detectHashChanges(committedFiles, getOldFileContent, WORKSPACE);

    // Should return null because the only affected parameter has no stored signature
    expect(result).toBeNull();
  });

  // =========================================================================
  // Scenario 8: Event referenced by nodes in multiple graphs → all detected
  // =========================================================================
  it('should detect hash changes across multiple graphs referencing the same event', async () => {
    const oldEventData = makeEventData('evt-shared', { amplitude_filters: [] });
    const newEventData = makeEventData('evt-shared', {
      amplitude_filters: [{ subprop_key: 'country', subprop_op: 'is', subprop_value: ['UK'] }],
    });

    // Graph 1 uses evt-shared
    const graphData1 = makeGraph({
      nodes: [
        { id: 'g1n1', uuid: 'g1n1', event_id: 'evt-shared' },
        { id: 'g1n2', uuid: 'g1n2', event_id: 'evt-end' },
      ],
      edges: [
        { uuid: 'g1e1', from: 'g1n1', to: 'g1n2', query: 'from(g1n1).to(g1n2)', paramId: 'param-g1' },
      ],
      metadata: { name: 'Graph One' },
    });

    // Graph 2 also uses evt-shared
    const graphData2 = makeGraph({
      nodes: [
        { id: 'g2n1', uuid: 'g2n1', event_id: 'evt-shared' },
        { id: 'g2n2', uuid: 'g2n2', event_id: 'evt-finish' },
      ],
      edges: [
        { uuid: 'g2e1', from: 'g2n1', to: 'g2n2', query: 'from(g2n1).to(g2n2)', paramId: 'param-g2' },
      ],
      metadata: { name: 'Graph Two' },
    });

    await seedGraph('graph-one', graphData1);
    await seedGraph('graph-two', graphData2);
    await seedEvent('evt-shared', newEventData);
    await seedEvent('evt-end', makeEventData('evt-end'));
    await seedEvent('evt-finish', makeEventData('evt-finish'));

    // Old signatures
    const oldSig1 = await computeSignatureForEdge(
      graphData1,
      graphData1.edges[0],
      { 'evt-shared': oldEventData, 'evt-end': makeEventData('evt-end') },
    );
    const oldSig2 = await computeSignatureForEdge(
      graphData2,
      graphData2.edges[0],
      { 'evt-shared': oldEventData, 'evt-finish': makeEventData('evt-finish') },
    );

    await seedParameter('param-g1', oldSig1, 'graph-one');
    await seedParameter('param-g2', oldSig2, 'graph-two');

    const committedFiles = [
      {
        fileId: 'event-evt-shared',
        type: 'event',
        data: newEventData,
        source: { path: 'events/evt-shared.yaml' },
      },
    ];

    const getOldFileContent = vi.fn().mockResolvedValue(oldEventData);

    const result = await commitHashGuardService.detectHashChanges(committedFiles, getOldFileContent, WORKSPACE);

    expect(result).not.toBeNull();

    // Should have one changedFile entry for the event
    expect(result!.changedFiles).toHaveLength(1);
    expect(result!.changedFiles[0].fileId).toBe('event-evt-shared');

    // Should reference both graphs
    const graphFileIds = result!.changedFiles[0].graphs.map((g) => g.graphFileId).sort();
    expect(graphFileIds).toContain('graph-one');
    expect(graphFileIds).toContain('graph-two');
    expect(result!.totalMappings).toBeGreaterThanOrEqual(2);
  });

  // =========================================================================
  // Scenario 9: Non-hash-breaking change (description only) → returns null
  // =========================================================================
  it('should return null when event change does not affect the hash (description-only change)', async () => {
    const oldEventData = makeEventData('evt-desc', {
      description: 'Old description',
      amplitude_filters: [{ subprop_key: 'platform', subprop_op: 'is', subprop_value: ['web'] }],
      provider_event_names: { amplitude: ['evt_desc_amp'] },
    });

    // Only description changed — amplitude_filters and provider_event_names are identical
    const newEventData = makeEventData('evt-desc', {
      description: 'Updated description with more detail',
      amplitude_filters: [{ subprop_key: 'platform', subprop_op: 'is', subprop_value: ['web'] }],
      provider_event_names: { amplitude: ['evt_desc_amp'] },
    });

    const graphData = makeGraph({
      nodes: [
        { id: 'nd1', uuid: 'nd1', event_id: 'evt-desc' },
        { id: 'nd2', uuid: 'nd2', event_id: 'evt-other' },
      ],
      edges: [
        { uuid: 'ed1', from: 'nd1', to: 'nd2', query: 'from(nd1).to(nd2)', paramId: 'param-desc' },
      ],
      metadata: { name: 'Desc Graph' },
    });

    await seedGraph('graph-desc', graphData);
    await seedEvent('evt-desc', newEventData);
    await seedEvent('evt-other', makeEventData('evt-other'));

    // Compute old signature — uses same hash-relevant fields
    const eventDefs = {
      'evt-desc': oldEventData,
      'evt-other': makeEventData('evt-other'),
    };
    const oldSig = await computeSignatureForEdge(graphData, graphData.edges[0], eventDefs);

    await seedParameter('param-desc', oldSig, 'graph-desc');

    const committedFiles = [
      {
        fileId: 'event-evt-desc',
        type: 'event',
        data: newEventData,
        source: { path: 'events/evt-desc.yaml' },
      },
    ];

    const getOldFileContent = vi.fn().mockResolvedValue(oldEventData);

    const result = await commitHashGuardService.detectHashChanges(committedFiles, getOldFileContent, WORKSPACE);

    // Description-only change should not affect the hash, so no mappings needed
    expect(result).toBeNull();
  });

  // =========================================================================
  // Scenario 10: Verify oldCoreHash and newCoreHash are correctly computed
  // =========================================================================
  it('should produce oldCoreHash and newCoreHash that match independently computed values', async () => {
    const oldEventData = makeEventData('evt-verify', {
      amplitude_filters: [],
      provider_event_names: { amplitude: ['original_name'] },
    });

    const newEventData = makeEventData('evt-verify', {
      amplitude_filters: [
        { subprop_key: 'region', subprop_op: 'is', subprop_value: ['EU'] },
      ],
      provider_event_names: { amplitude: ['original_name'] },
    });

    const graphData = makeGraph({
      nodes: [
        { id: 'nv1', uuid: 'nv1', event_id: 'evt-verify' },
        { id: 'nv2', uuid: 'nv2', event_id: 'evt-end' },
      ],
      edges: [
        { uuid: 'ev1', from: 'nv1', to: 'nv2', query: 'from(nv1).to(nv2)', paramId: 'param-verify' },
      ],
      metadata: { name: 'Verify Graph' },
    });

    await seedGraph('graph-verify', graphData);
    await seedEvent('evt-verify', newEventData);
    await seedEvent('evt-end', makeEventData('evt-end'));

    // Independently compute both old and new signatures
    const edge = graphData.edges[0];
    const oldEventDefs = { 'evt-verify': oldEventData, 'evt-end': makeEventData('evt-end') };
    const newEventDefs = { 'evt-verify': newEventData, 'evt-end': makeEventData('evt-end') };

    const oldSignature = await computeSignatureForEdge(graphData, edge, oldEventDefs);
    const newSignature = await computeSignatureForEdge(graphData, edge, newEventDefs);

    // Compute short core_hashes (the format used by the snapshot DB and hash-mappings.json)
    const oldShortHash = await computeShortCoreHash(oldSignature);
    const newShortHash = await computeShortCoreHash(newSignature);

    // Verify our independently computed hashes are actually different
    expect(oldShortHash).not.toBe(newShortHash);

    await seedParameter('param-verify', oldSignature, 'graph-verify');

    const committedFiles = [
      {
        fileId: 'event-evt-verify',
        type: 'event',
        data: newEventData,
        source: { path: 'events/evt-verify.yaml' },
      },
    ];

    const getOldFileContent = vi.fn().mockResolvedValue(oldEventData);

    const result = await commitHashGuardService.detectHashChanges(committedFiles, getOldFileContent, WORKSPACE);

    expect(result).not.toBeNull();

    const item = result!.changedFiles[0].graphs[0].items[0];

    // The guard's oldCoreHash should match what we independently computed from the old event def
    expect(item.oldCoreHash).toBe(oldShortHash);

    // The guard's newCoreHash should match what we independently computed from the new event def
    expect(item.newCoreHash).toBe(newShortHash);

    // And they must differ
    expect(item.oldCoreHash).not.toBe(item.newCoreHash);
  });

  // =========================================================================
  // Edge case: Event file referenced by 'to' node (not just 'from')
  // =========================================================================
  it('should detect changes when the affected event is on the to-node of an edge', async () => {
    const oldEventData = makeEventData('evt-target', {
      provider_event_names: { amplitude: ['old_target'] },
    });
    const newEventData = makeEventData('evt-target', {
      provider_event_names: { amplitude: ['new_target_renamed'] },
    });

    const graphData = makeGraph({
      nodes: [
        { id: 'src', uuid: 'src', event_id: 'evt-source' },
        { id: 'tgt', uuid: 'tgt', event_id: 'evt-target' },
      ],
      edges: [
        { uuid: 'e-to', from: 'src', to: 'tgt', query: 'from(src).to(tgt)', paramId: 'param-to-node' },
      ],
      metadata: { name: 'To-Node Graph' },
    });

    await seedGraph('graph-to-node', graphData);
    await seedEvent('evt-source', makeEventData('evt-source'));
    await seedEvent('evt-target', newEventData);

    const oldSig = await computeSignatureForEdge(
      graphData,
      graphData.edges[0],
      { 'evt-source': makeEventData('evt-source'), 'evt-target': oldEventData },
    );

    await seedParameter('param-to-node', oldSig, 'graph-to-node');

    const committedFiles = [
      {
        fileId: 'event-evt-target',
        type: 'event',
        data: newEventData,
        source: { path: 'events/evt-target.yaml' },
      },
    ];

    const getOldFileContent = vi.fn().mockResolvedValue(oldEventData);

    const result = await commitHashGuardService.detectHashChanges(committedFiles, getOldFileContent, WORKSPACE);

    expect(result).not.toBeNull();
    expect(result!.totalMappings).toBeGreaterThanOrEqual(1);

    const item = result!.changedFiles[0].graphs[0].items[0];
    expect(item.paramId).toBe('param-to-node');
    expect(item.oldCoreHash).not.toBe(item.newCoreHash);
  });

  // =========================================================================
  // Edge case: Graph with unaffected edge should not appear in results
  // =========================================================================
  it('should not include edges whose nodes do not reference the changed event', async () => {
    const oldEventData = makeEventData('evt-changed', { amplitude_filters: [] });
    const newEventData = makeEventData('evt-changed', {
      amplitude_filters: [{ subprop_key: 'os', subprop_op: 'is', subprop_value: ['linux'] }],
    });

    // Graph with TWO edges — only one references the changed event
    const graphData = makeGraph({
      nodes: [
        { id: 'nA', uuid: 'nA', event_id: 'evt-changed' },
        { id: 'nB', uuid: 'nB', event_id: 'evt-stable' },
        { id: 'nC', uuid: 'nC', event_id: 'evt-unrelated' },
      ],
      edges: [
        { uuid: 'e-affected', from: 'nA', to: 'nB', query: 'from(nA).to(nB)', paramId: 'param-affected' },
        { uuid: 'e-unaffected', from: 'nB', to: 'nC', query: 'from(nB).to(nC)', paramId: 'param-unaffected' },
      ],
      metadata: { name: 'Mixed Graph' },
    });

    await seedGraph('graph-mixed', graphData);
    await seedEvent('evt-changed', newEventData);
    await seedEvent('evt-stable', makeEventData('evt-stable'));
    await seedEvent('evt-unrelated', makeEventData('evt-unrelated'));

    // Compute old sig for the affected edge only
    const oldSigAffected = await computeSignatureForEdge(
      graphData,
      graphData.edges[0],
      {
        'evt-changed': oldEventData,
        'evt-stable': makeEventData('evt-stable'),
      },
    );

    // For the unaffected edge, compute a sig with stable events
    const sigUnaffected = await computeSignatureForEdge(
      graphData,
      graphData.edges[1],
      {
        'evt-stable': makeEventData('evt-stable'),
        'evt-unrelated': makeEventData('evt-unrelated'),
      },
    );

    await seedParameter('param-affected', oldSigAffected, 'graph-mixed');
    await seedParameter('param-unaffected', sigUnaffected, 'graph-mixed');

    const committedFiles = [
      {
        fileId: 'event-evt-changed',
        type: 'event',
        data: newEventData,
        source: { path: 'events/evt-changed.yaml' },
      },
    ];

    const getOldFileContent = vi.fn().mockResolvedValue(oldEventData);

    const result = await commitHashGuardService.detectHashChanges(committedFiles, getOldFileContent, WORKSPACE);

    expect(result).not.toBeNull();

    // Only the affected parameter should appear
    const allParamIds = result!.changedFiles
      .flatMap((f) => f.graphs)
      .flatMap((g) => g.items)
      .map((i) => i.paramId);

    expect(allParamIds).toContain('param-affected');
    expect(allParamIds).not.toContain('param-unaffected');
  });
});
