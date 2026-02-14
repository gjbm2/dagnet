/**
 * Amplitude Funnel Builder — DAS Adapter Conformance Tests
 *
 * These tests verify that the funnel builder (amplitudeFunnelBuilderService)
 * produces the same Amplitude event/segment output as the DAS adapter
 * (connections.yaml pre_request script) would for equivalent queries.
 *
 * Since the funnel builder is a SEPARATE code path from the DAS adapter,
 * these conformance tests are critical for catching divergence.
 *
 * For each constraint type, we:
 * 1. Set up the same graph/event/DSL inputs
 * 2. Call the funnel builder
 * 3. Assert the output matches what the DAS adapter produces
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildAmplitudeFunnelDefinition, resolveEvent, normalizeProp, computeCohortConversionSeconds, chartDefinitionToRestParams } from '../amplitudeFunnelBuilderService';

// Mock fileRegistry
vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    getFile: vi.fn(),
  },
}));

// Mock context registry used by shared DAS context resolver
vi.mock('../../services/contextRegistry', () => ({
  contextRegistry: {
    getContext: vi.fn(async (key: string) => ({
      id: key,
      values: [{ id: 'dummy' }, { id: 'other' }],
      otherPolicy: 'computed',
    })),
    getSourceMapping: vi.fn(async (key: string, value: string, source: string) => {
      if (source !== 'amplitude') return null;
      if (key === 'channel') return { field: 'utm_medium', filter: `utm_medium == '${value}'` };
      if (key === 'country') return { field: 'country', filter: `country == '${value}'` };
      return { field: key, filter: `${key} == '${value}'` };
    }),
  },
}));

import { fileRegistry } from '../../contexts/TabContext';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, eventId?: string) {
  return { id, uuid: `uuid-${id}`, event_id: eventId || id, label: id };
}

function makeEdge(source: string, target: string) {
  return { source, target };
}

function mockEventFile(eventId: string, amplitudeName: string, filters?: any[]) {
  return {
    data: {
      id: eventId,
      provider_event_names: { amplitude: amplitudeName },
      amplitude_filters: filters || [],
    },
  };
}

// ---------------------------------------------------------------------------
// Event resolution conformance
// ---------------------------------------------------------------------------

describe('Event resolution — conformance with DAS adapter getEventInfo + buildEventStepFromId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves event_id to Amplitude provider name', () => {
    vi.spyOn(fileRegistry, 'getFile').mockImplementation((fileId: string) => {
      if (fileId === 'event-household-created') {
        return mockEventFile('household-created', 'Household Created');
      }
      return null;
    });

    const { amplitudeName } = resolveEvent('household-created');
    expect(amplitudeName).toBe('Household Created');
  });

  it('falls back to event_id when no event file exists (matches DAS adapter)', () => {
    vi.spyOn(fileRegistry, 'getFile').mockReturnValue(null);

    const { amplitudeName } = resolveEvent('unknown-event');
    expect(amplitudeName).toBe('unknown-event');
  });

  it('maps amplitude_filters with correct operator mapping (matches DAS adapter)', () => {
    vi.spyOn(fileRegistry, 'getFile').mockImplementation((fileId: string) => {
      if (fileId === 'event-switch-success') {
        return mockEventFile('switch-success', 'HouseholdServiceSwitch Registered', [
          { property: 'step', operator: 'is', values: ['register'] },
          { property: 'flowId', operator: 'is any of', values: ['energy-switch', 'broadband-switch'] },
        ]);
      }
      return null;
    });

    const { filters } = resolveEvent('switch-success');

    // DAS adapter produces: { subprop_type: "event", subprop_key: "step", subprop_op: "is", subprop_value: ["register"] }
    expect(filters).toHaveLength(2);
    expect(filters[0]).toEqual({
      subprop_type: 'event',
      subprop_key: 'step',
      subprop_op: 'is',
      subprop_value: ['register'],
      group_type: 'User',
      subfilters: [],
    });
    // "is any of" maps to "is" in both DAS adapter and funnel builder
    expect(filters[1].subprop_op).toBe('is');
    expect(filters[1].subprop_value).toEqual(['energy-switch', 'broadband-switch']);
  });
});

// ---------------------------------------------------------------------------
// Property name normalisation conformance
// ---------------------------------------------------------------------------

describe('normalizeProp — conformance with DAS adapter normalizeProp', () => {
  it('passes through built-in user properties without prefix', () => {
    expect(normalizeProp('country')).toBe('country');
    expect(normalizeProp('platform')).toBe('platform');
    expect(normalizeProp('device_type')).toBe('device_type');
    expect(normalizeProp('userdata_cohort')).toBe('userdata_cohort');
  });

  it('adds gp: prefix to custom user properties', () => {
    expect(normalizeProp('utm_medium')).toBe('gp:utm_medium');
    expect(normalizeProp('utm_campaign')).toBe('gp:utm_campaign');
    expect(normalizeProp('email')).toBe('gp:email');
  });

  it('does not double-prefix properties already starting with gp:', () => {
    expect(normalizeProp('gp:utm_medium')).toBe('gp:utm_medium');
  });
});

// ---------------------------------------------------------------------------
// Segment condition conformance
// ---------------------------------------------------------------------------

describe('Segment conditions — conformance with DAS adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fileRegistry, 'getFile').mockImplementation((fileId: string) => {
      const id = fileId.replace('event-', '');
      return mockEventFile(id, `Amplitude_${id}`);
    });
  });

  it('strips asat()/at() and adds a warning instead of blocking (Amplitude has no snapshot semantics)', async () => {
    const resultAsat = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a'],
      graphNodes: [makeNode('a', 'event-a')],
      graphEdges: [],
      effectiveDsl: 'from(a).to(a).asat(5-Nov-25)',
      appId: 'test-app-id',
    });

    // Should succeed (not throw) and include a warning about asat removal
    expect(resultAsat.warnings.some(w => /asat\(\)/i.test(w))).toBe(true);
    // Should still produce a funnel with events
    expect(resultAsat.definition.params.events.length).toBeGreaterThan(0);

    const resultAt = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a'],
      graphNodes: [makeNode('a', 'event-a')],
      graphEdges: [],
      effectiveDsl: 'from(a).to(a).at(5-Nov-25)',
      appId: 'test-app-id',
    });

    expect(resultAt.warnings.some(w => /asat\(\)/i.test(w))).toBe(true);
    expect(resultAt.definition.params.events.length).toBeGreaterThan(0);
  });

  it('cohort exclusion matches DAS adapter output', async () => {
    // DAS adapter: { prop: "userdata_cohort", op: "is not", values: ["9z057h6i"] }
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a'],
      graphNodes: [makeNode('a', 'event-a')],
      graphEdges: [],
      effectiveDsl: null,
      appId: 'test-app-id',
      connectionDefaults: { excluded_cohorts: ['9z057h6i'] },
    });

    const conditions = result.definition.params.segments[0].conditions;
    expect(conditions).toContainEqual({
      type: 'property',
      prop_type: 'user',
      prop: 'userdata_cohort',
      op: 'is not',
      values: ['9z057h6i'],
      group_type: 'User',
    });
  });

  it('exclude() produces behavioural "= 0" condition (matches DAS adapter)', async () => {
    // DAS adapter: { type: "event", event_type: "...", op: "=", value: 0, time_type: "rolling", time_value: 366 }
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a', 'b'],
      graphNodes: [makeNode('a', 'event-a'), makeNode('b', 'event-b'), makeNode('x', 'event-x')],
      graphEdges: [makeEdge('a', 'b')],
      effectiveDsl: 'from(a).to(b).exclude(x)',
      appId: 'test-app-id',
    });

    const conditions = result.definition.params.segments[0].conditions;
    expect(conditions).toContainEqual({
      type: 'event',
      event_type: 'Amplitude_event-x',
      filters: [],
      op: '=',
      value: 0,
      time_type: 'rolling',
      time_value: 366,
      group_type: 'User',
    });
  });

  it('warns when exclude() targets a funnel step (contradictory constraints)', async () => {
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a', 'b'],
      graphNodes: [makeNode('a', 'event-a'), makeNode('b', 'event-b')],
      graphEdges: [makeEdge('a', 'b')],
      effectiveDsl: 'from(a).to(b).exclude(b)',
      appId: 'test-app-id',
    });
    expect(result.warnings.some(w => /Contradictory constraints/i.test(w))).toBe(true);
  });

  it('visited() outside selection produces behavioural ">= 1" condition (matches DAS adapter)', async () => {
    // DAS adapter: { type: "event", event_type: "...", op: ">=", value: 1, time_type: "rolling", time_value: 366 }
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['b', 'c'],
      graphNodes: [makeNode('a', 'event-a'), makeNode('b', 'event-b'), makeNode('c', 'event-c')],
      graphEdges: [makeEdge('b', 'c')],
      effectiveDsl: 'from(b).to(c).visited(a)',
      appId: 'test-app-id',
    });

    const conditions = result.definition.params.segments[0].conditions;
    expect(conditions).toContainEqual({
      type: 'event',
      event_type: 'Amplitude_event-a',
      filters: [],
      op: '>=',
      value: 1,
      time_type: 'rolling',
      time_value: 366,
      group_type: 'User',
    });
  });

  it('visited() inside selection is dropped (implicit in funnel ordering)', async () => {
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a', 'b', 'c'],
      graphNodes: [makeNode('a', 'event-a'), makeNode('b', 'event-b'), makeNode('c', 'event-c')],
      graphEdges: [makeEdge('a', 'b'), makeEdge('b', 'c')],
      effectiveDsl: 'from(a).to(c).visited(b)',
      appId: 'test-app-id',
    });

    const conditions = result.definition.params.segments[0].conditions;
    // b should NOT appear as a segment condition — it's already a funnel step
    const bConditions = conditions.filter((c: any) => c.event_type === 'Amplitude_event-b');
    expect(bConditions).toHaveLength(0);
  });

  it('context() produces property condition with correct gp: prefix (matches DAS adapter)', async () => {
    // DAS adapter: { prop: "gp:utm_medium", op: "is", values: ["cpc"] }
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a'],
      graphNodes: [makeNode('a', 'event-a')],
      graphEdges: [],
      effectiveDsl: 'from(a).context(utm_medium:cpc)',
      appId: 'test-app-id',
    });

    const conditions = result.definition.params.segments[0].conditions;
    expect(conditions).toContainEqual({
      type: 'property',
      prop_type: 'user',
      prop: 'gp:utm_medium',
      op: 'is',
      values: ['cpc'],
      group_type: 'User',
    });
  });

  it('context() with built-in prop has no gp: prefix (matches DAS adapter)', async () => {
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a'],
      graphNodes: [makeNode('a', 'event-a')],
      graphEdges: [],
      effectiveDsl: 'from(a).context(country:United Kingdom)',
      appId: 'test-app-id',
    });

    const conditions = result.definition.params.segments[0].conditions;
    expect(conditions).toContainEqual({
      type: 'property',
      prop_type: 'user',
      prop: 'country',
      op: 'is',
      values: ['United Kingdom'],
      group_type: 'User',
    });
  });

  it('case() produces activeGates property condition (matches DAS adapter)', async () => {
    // DAS adapter: { prop: "activeGates.experiment_coffee_promotion", op: "is", values: ["true"] }
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a'],
      graphNodes: [makeNode('a', 'event-a')],
      graphEdges: [],
      effectiveDsl: 'from(a).case(coffee-promotion:treatment)',
      appId: 'test-app-id',
    });

    const conditions = result.definition.params.segments[0].conditions;
    expect(conditions).toContainEqual({
      type: 'property',
      prop_type: 'user',
      prop: 'activeGates.coffee_promotion',
      op: 'is',
      values: ['true'],
      group_type: 'User',
    });
  });

  it('case() with control variant resolves to false (matches DAS adapter)', async () => {
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a'],
      graphNodes: [makeNode('a', 'event-a')],
      graphEdges: [],
      effectiveDsl: 'from(a).case(coffee-promotion:control)',
      appId: 'test-app-id',
    });

    const conditions = result.definition.params.segments[0].conditions;
    expect(conditions).toContainEqual({
      type: 'property',
      prop_type: 'user',
      prop: 'activeGates.coffee_promotion',
      op: 'is',
      values: ['false'],
      group_type: 'User',
    });
  });

  it('warns and ignores visitedAny() because it is not representable in current funnel segments', async () => {
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a', 'b'],
      graphNodes: [makeNode('a', 'event-a'), makeNode('b', 'event-b'), makeNode('x', 'event-x')],
      graphEdges: [makeEdge('a', 'b')],
      effectiveDsl: 'from(a).to(b).visitedAny(x,b)',
      appId: 'test-app-id',
    });
    expect(result.warnings.some(w => /visitedAny\(\)/i.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Funnel step ordering
// ---------------------------------------------------------------------------

describe('Funnel step ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fileRegistry, 'getFile').mockImplementation((fileId: string) => {
      const id = fileId.replace('event-', '');
      return mockEventFile(id, `Amp_${id}`);
    });
  });

  it('topologically sorts selected nodes using graph edges', async () => {
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['c', 'a', 'b'], // Out of order
      graphNodes: [makeNode('a', 'event-a'), makeNode('b', 'event-b'), makeNode('c', 'event-c')],
      graphEdges: [makeEdge('a', 'b'), makeEdge('b', 'c')],
      effectiveDsl: null,
      appId: 'test-app-id',
    });

    const eventNames = result.definition.params.events.map((e: any) => e.event_type);
    expect(eventNames).toEqual(['Amp_event-a', 'Amp_event-b', 'Amp_event-c']);
  });

  it('warns for non-linear selections but still proceeds', async () => {
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a', 'b', 'c'],
      graphNodes: [makeNode('a', 'event-a'), makeNode('b', 'event-b'), makeNode('c', 'event-c')],
      graphEdges: [makeEdge('a', 'b'), makeEdge('a', 'c')],
      effectiveDsl: null,
      appId: 'test-app-id',
    });
    expect(result.warnings.some(w => /non-linear/i.test(w))).toBe(true);
  });

  it('skips nodes without event_id and warns', async () => {
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a', 'no-event', 'c'],
      graphNodes: [
        makeNode('a', 'event-a'),
        { id: 'no-event', uuid: 'uuid-no-event' }, // No event_id
        makeNode('c', 'event-c'),
      ],
      graphEdges: [makeEdge('a', 'c')],
      effectiveDsl: null,
      appId: 'test-app-id',
    });

    expect(result.definition.params.events).toHaveLength(2);
    expect(result.warnings).toContain('Node "no-event" has no event_id.');
  });
});

// ---------------------------------------------------------------------------
// Date handling
// ---------------------------------------------------------------------------

describe('Date handling — window vs cohort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fileRegistry, 'getFile').mockImplementation((fileId: string) => {
      const id = fileId.replace('event-', '');
      return mockEventFile(id, `Amp_${id}`);
    });
  });

  it('window() sets absolute start/end epoch seconds', async () => {
    // Window DSL uses UK date format (d-MMM-yy), not ISO
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a'],
      graphNodes: [makeNode('a', 'event-a')],
      graphEdges: [],
      effectiveDsl: 'from(a).window(1-Jan-25:31-Mar-25)',
      appId: 'test-app-id',
    });

    const params = result.definition.params as any;
    // Should have numeric start/end (epoch seconds), not "Last 30 Days"
    expect(typeof params.start).toBe('number');
    expect(typeof params.end).toBe('number');
    expect(params.start).toBeGreaterThan(0);
    expect(params.end).toBeGreaterThan(params.start);
    expect(params.range).toBeUndefined();
  });

  it('no dates defaults to "Last 30 Days"', async () => {
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a'],
      graphNodes: [makeNode('a', 'event-a')],
      graphEdges: [],
      effectiveDsl: 'from(a)',
      appId: 'test-app-id',
    });

    const params = result.definition.params as any;
    expect(params.range).toBe('Last 30 Days');
  });

  it('cohort() uses graph-derived conversion window, not hardcoded 30d', async () => {
    // Graph has edges with path_t95=49.15 and path_t95=40.43
    // Expected: ceil(max(49.15, 40.43)) = 50 days → 50 * 86400 = 4320000 seconds
    const edgesWithLatency = [
      { ...makeEdge('a', 'b'), p: { mean: 0.5, latency: { path_t95: 40.43, t95: 22.85, anchor_node_id: 'start' } } },
      { ...makeEdge('b', 'c'), p: { mean: 0.5, latency: { path_t95: 49.15, t95: 12.68, anchor_node_id: 'start' } } },
    ];

    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a', 'b', 'c'],
      graphNodes: [makeNode('a', 'event-a'), makeNode('b', 'event-b'), makeNode('c', 'event-c')],
      graphEdges: edgesWithLatency,
      effectiveDsl: 'cohort(15-Jan-26:13-Feb-26)',
      appId: 'test-app-id',
    });

    const params = result.definition.params as any;
    // 50 days * 86400 = 4320000
    expect(params.conversionSeconds).toBe(50 * 86400);
  });

  it('cohort() falls back to DEFAULT_T95_DAYS (30d) when no latency on edges', async () => {
    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a'],
      graphNodes: [makeNode('a', 'event-a')],
      graphEdges: [],
      effectiveDsl: 'cohort(1-Jan-26:31-Jan-26)',
      appId: 'test-app-id',
    });

    const params = result.definition.params as any;
    expect(params.conversionSeconds).toBe(30 * 86400);
  });

  it('cohort() caps conversion window at 90 days', async () => {
    const edgesWithHugeLatency = [
      { ...makeEdge('a', 'b'), p: { mean: 0.5, latency: { path_t95: 200, t95: 150, anchor_node_id: 'start' } } },
    ];

    const result = await buildAmplitudeFunnelDefinition({
      selectedNodeIds: ['a', 'b'],
      graphNodes: [makeNode('a', 'event-a'), makeNode('b', 'event-b')],
      graphEdges: edgesWithHugeLatency,
      effectiveDsl: 'cohort(1-Jan-26:31-Jan-26)',
      appId: 'test-app-id',
    });

    const params = result.definition.params as any;
    expect(params.conversionSeconds).toBe(90 * 86400);
  });
});

// ---------------------------------------------------------------------------
// computeCohortConversionSeconds (unit)
// ---------------------------------------------------------------------------

describe('computeCohortConversionSeconds', () => {
  it('uses max(path_t95, t95) across edges', () => {
    const edges = [
      { p: { latency: { path_t95: 40.43, t95: 22.85 } } },
      { p: { latency: { path_t95: 49.15, t95: 12.68 } } },
    ];
    // max(40.43, 49.15) = 49.15 → ceil = 50 → 50 * 86400
    expect(computeCohortConversionSeconds(edges)).toBe(50 * 86400);
  });

  it('falls back to t95 when path_t95 missing', () => {
    const edges = [
      { p: { latency: { t95: 15.3 } } },
      { p: { latency: { t95: 22.1 } } },
    ];
    // max(15.3, 22.1) = 22.1 → ceil = 23 → 23 * 86400
    expect(computeCohortConversionSeconds(edges)).toBe(23 * 86400);
  });

  it('returns DEFAULT_T95_DAYS when no latency data', () => {
    expect(computeCohortConversionSeconds([])).toBe(30 * 86400);
    expect(computeCohortConversionSeconds([{ p: { mean: 0.5 } }])).toBe(30 * 86400);
  });

  it('caps at COHORT_CONVERSION_WINDOW_MAX_DAYS (90)', () => {
    const edges = [{ p: { latency: { path_t95: 150 } } }];
    expect(computeCohortConversionSeconds(edges)).toBe(90 * 86400);
  });
});

// ---------------------------------------------------------------------------
// chartDefinitionToRestParams converter
// ---------------------------------------------------------------------------

describe('chartDefinitionToRestParams', () => {
  it('converts events to repeated e= params', () => {
    const def = {
      app: 'test-app-id', type: 'funnels', vis: 'bar', version: 41, name: null,
      params: {
        mode: 'ordered',
        start: 1737936000, // 27-Jan-25 00:00 UTC
        end: 1738540800,   // 03-Feb-25 00:00 UTC
        conversionSeconds: 2592000,
        newOrActive: 'active',
        events: [
          { event_type: 'Household Created', filters: [], group_by: [] },
          { event_type: 'Household DelegationStatusChanged', filters: [{ subprop_type: 'event', subprop_key: 'newDelegationStatus', subprop_op: 'is', subprop_value: ['ON'] }], group_by: [] },
        ],
        segments: [{ name: 'All Users', label: '', conditions: [] }],
      },
    } as any;

    const qs = chartDefinitionToRestParams(def);
    // Should have two e= params
    const eParams = qs.split('&').filter(p => p.startsWith('e='));
    expect(eParams).toHaveLength(2);

    // First event: no filters
    const e1 = JSON.parse(decodeURIComponent(eParams[0].replace('e=', '')));
    expect(e1.event_type).toBe('Household Created');
    expect(e1.filters).toBeUndefined(); // empty array omitted

    // Second event: has filters
    const e2 = JSON.parse(decodeURIComponent(eParams[1].replace('e=', '')));
    expect(e2.event_type).toBe('Household DelegationStatusChanged');
    expect(e2.filters).toHaveLength(1);
    expect(e2.filters[0].subprop_key).toBe('newDelegationStatus');

    // Dates should be YYYYMMDD
    expect(qs).toContain('start=20250127');
    expect(qs).toContain('end=20250203');
    expect(qs).toContain('cs=2592000');
    expect(qs).toContain('mode=ordered');
    expect(qs).toContain('n=active');
  });

  it('includes segment conditions when present', () => {
    const def = {
      app: 'test-app-id', type: 'funnels', vis: 'bar', version: 41, name: null,
      params: {
        mode: 'ordered',
        start: 1737936000,
        end: 1738540800,
        conversionSeconds: 86400,
        events: [{ event_type: 'TestEvent', filters: [], group_by: [] }],
        segments: [{
          name: 'DagNet Constraints', label: '',
          conditions: [
            { prop: 'userdata_cohort', op: 'is not', values: ['9z057h6i'] },
            { type: 'event', event_type: 'ExcludedEvent', op: '=', value: 0, time_type: 'rolling', time_value: 366 },
          ],
        }],
      },
    } as any;

    const qs = chartDefinitionToRestParams(def);
    expect(qs).toContain('s=');
    const sParam = qs.split('&').find(p => p.startsWith('s='));
    const conditions = JSON.parse(decodeURIComponent(sParam!.replace('s=', '')));
    expect(conditions).toHaveLength(2);
    expect(conditions[0].prop).toBe('userdata_cohort');
    expect(conditions[1].event_type).toBe('ExcludedEvent');
  });
});
