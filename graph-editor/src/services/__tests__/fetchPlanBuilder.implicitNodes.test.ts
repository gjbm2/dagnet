/**
 * fetchPlanBuilderService — implicit node skip logic.
 *
 * Verifies that edges between nodes without event_id are classified as 'unfetchable'
 * rather than being attempted and failing at execution time.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { buildFetchPlan, type ConnectionChecker, type FileStateAccessor } from '../fetchPlanBuilderService';
import type { Graph, DateRange } from '../../types';
import type { ParameterValue } from '../../types/parameterData';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    nodes: [],
    edges: [],
    policies: { default_outcome: 'pass' },
    metadata: { version: '1.0.0', created_at: '2026-01-01' },
    ...overrides,
  } as Graph;
}

const alwaysConnected: ConnectionChecker = {
  hasEdgeConnection: () => true,
  hasCaseConnection: () => true,
};

const neverConnected: ConnectionChecker = {
  hasEdgeConnection: () => false,
  hasCaseConnection: () => false,
};

const emptyFileState: FileStateAccessor = {
  getParameterFile: () => ({ data: { values: [] } }),
  getCaseFile: () => undefined,
};

const window: DateRange = { start: '1-Jan-26', end: '31-Jan-26' };
const refNow = '2026-02-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchPlanBuilder — implicit node event_id validation', () => {
  it('classifies edge as fetch when both nodes have event_id', () => {
    const graph = makeGraph({
      nodes: [
        { id: 'n1', label: 'Checkout', event_id: 'checkout_viewed', x: 0, y: 0 },
        { id: 'n2', label: 'Purchase', event_id: 'purchase_completed', x: 100, y: 0 },
      ] as any,
      edges: [
        { id: 'e1', uuid: 'e1', from: 'n1', to: 'n2', p: { id: 'param-1', mean: 0.5, connection: 'amplitude-prod' } },
      ] as any,
    });

    const { plan } = buildFetchPlan({
      graph,
      dsl: 'window(1-Jan-26:31-Jan-26)',
      window,
      referenceNow: refNow,
      fileState: emptyFileState,
      connectionChecker: alwaysConnected,
    });

    const item = plan.items.find(i => i.objectId === 'param-1');
    expect(item).toBeDefined();
    expect(item!.classification).not.toBe('unfetchable');
  });

  it('classifies edge as unfetchable (no_event_ids) when both nodes lack event_id', () => {
    const graph = makeGraph({
      nodes: [
        { id: 'n1', label: 'Start', x: 0, y: 0 },
        { id: 'n2', label: 'End', x: 100, y: 0 },
      ] as any,
      edges: [
        { id: 'e1', uuid: 'e1', from: 'n1', to: 'n2', p: { id: 'param-1', mean: 0.5, connection: 'amplitude-prod' } },
      ] as any,
    });

    const { plan } = buildFetchPlan({
      graph,
      dsl: 'window(1-Jan-26:31-Jan-26)',
      window,
      referenceNow: refNow,
      fileState: emptyFileState,
      connectionChecker: alwaysConnected,
    });

    const item = plan.items.find(i => i.objectId === 'param-1');
    expect(item).toBeDefined();
    expect(item!.classification).toBe('unfetchable');
    expect(item!.unfetchableReason).toBe('no_event_ids');
  });

  it('classifies edge as unfetchable (partial_event_ids) when only from node has event_id', () => {
    const graph = makeGraph({
      nodes: [
        { id: 'n1', label: 'Checkout', event_id: 'checkout_viewed', x: 0, y: 0 },
        { id: 'n2', label: 'Structural', x: 100, y: 0 },
      ] as any,
      edges: [
        { id: 'e1', uuid: 'e1', from: 'n1', to: 'n2', p: { id: 'param-1', mean: 0.5, connection: 'amplitude-prod' } },
      ] as any,
    });

    const { plan } = buildFetchPlan({
      graph,
      dsl: 'window(1-Jan-26:31-Jan-26)',
      window,
      referenceNow: refNow,
      fileState: emptyFileState,
      connectionChecker: alwaysConnected,
    });

    const item = plan.items.find(i => i.objectId === 'param-1');
    expect(item).toBeDefined();
    expect(item!.classification).toBe('unfetchable');
    expect(item!.unfetchableReason).toBe('partial_event_ids');
  });

  it('classifies edge as unfetchable (partial_event_ids) when only to node has event_id', () => {
    const graph = makeGraph({
      nodes: [
        { id: 'n1', label: 'Structural', x: 0, y: 0 },
        { id: 'n2', label: 'Purchase', event_id: 'purchase_completed', x: 100, y: 0 },
      ] as any,
      edges: [
        { id: 'e1', uuid: 'e1', from: 'n1', to: 'n2', p: { id: 'param-1', mean: 0.5, connection: 'amplitude-prod' } },
      ] as any,
    });

    const { plan } = buildFetchPlan({
      graph,
      dsl: 'window(1-Jan-26:31-Jan-26)',
      window,
      referenceNow: refNow,
      fileState: emptyFileState,
      connectionChecker: alwaysConnected,
    });

    const item = plan.items.find(i => i.objectId === 'param-1');
    expect(item).toBeDefined();
    expect(item!.classification).toBe('unfetchable');
    expect(item!.unfetchableReason).toBe('partial_event_ids');
  });

  it('skips event_id check when edge has no connection (unfetchable for other reasons)', () => {
    const graph = makeGraph({
      nodes: [
        { id: 'n1', label: 'Start', x: 0, y: 0 },
        { id: 'n2', label: 'End', x: 100, y: 0 },
      ] as any,
      edges: [
        { id: 'e1', uuid: 'e1', from: 'n1', to: 'n2', p: { id: 'param-1', mean: 0.5 } },
      ] as any,
    });

    const { plan } = buildFetchPlan({
      graph,
      dsl: 'window(1-Jan-26:31-Jan-26)',
      window,
      referenceNow: refNow,
      fileState: emptyFileState,
      connectionChecker: neverConnected,
    });

    const item = plan.items.find(i => i.objectId === 'param-1');
    expect(item).toBeDefined();
    expect(item!.classification).toBe('unfetchable');
    // Unfetchable because no connection, not because of event_ids
    expect(item!.unfetchableReason).not.toBe('no_event_ids');
    expect(item!.unfetchableReason).not.toBe('partial_event_ids');
  });

  it('bulk plan: structural edges skipped, analytics edges kept', () => {
    const graph = makeGraph({
      nodes: [
        { id: 'n1', label: 'Checkout', event_id: 'checkout', x: 0, y: 0 },
        { id: 'n2', label: 'Purchase', event_id: 'purchase', x: 100, y: 0 },
        { id: 'n3', label: 'Structural A', x: 200, y: 0 },
        { id: 'n4', label: 'Structural B', x: 300, y: 0 },
      ] as any,
      edges: [
        { id: 'e1', uuid: 'e1', from: 'n1', to: 'n2', p: { id: 'param-analytics', mean: 0.5, connection: 'amplitude-prod' } },
        { id: 'e2', uuid: 'e2', from: 'n3', to: 'n4', p: { id: 'param-structural', mean: 0.3, connection: 'amplitude-prod' } },
      ] as any,
    });

    const { plan } = buildFetchPlan({
      graph,
      dsl: 'window(1-Jan-26:31-Jan-26)',
      window,
      referenceNow: refNow,
      fileState: emptyFileState,
      connectionChecker: alwaysConnected,
    });

    const analytics = plan.items.find(i => i.objectId === 'param-analytics');
    const structural = plan.items.find(i => i.objectId === 'param-structural');

    expect(analytics).toBeDefined();
    expect(analytics!.classification).not.toBe('unfetchable');

    expect(structural).toBeDefined();
    expect(structural!.classification).toBe('unfetchable');
    expect(structural!.unfetchableReason).toBe('no_event_ids');
  });

  it('does NOT classify as no_event_ids when connection does not require event_ids (e.g. sheets)', () => {
    const checker: ConnectionChecker = {
      hasEdgeConnection: () => true,
      hasCaseConnection: () => true,
      requiresEventIds: (connectionName) => {
        if (connectionName === 'sheets-readonly') return false;
        return true;
      },
    };

    const graph = makeGraph({
      nodes: [
        { id: 'n1', label: 'Structural A', x: 0, y: 0 },
        { id: 'n2', label: 'Structural B', x: 100, y: 0 },
      ] as any,
      edges: [
        { id: 'e1', uuid: 'e1', from: 'n1', to: 'n2', p: { id: 'param-sheets', mean: 0.5, connection: 'sheets-readonly' } },
      ] as any,
    });

    const { plan } = buildFetchPlan({
      graph,
      dsl: 'window(1-Jan-26:31-Jan-26)',
      window,
      referenceNow: refNow,
      fileState: emptyFileState,
      connectionChecker: checker,
    });

    const item = plan.items.find(i => i.objectId === 'param-sheets');
    expect(item).toBeDefined();
    // Should not be filtered out by event_id validation.
    expect(item!.unfetchableReason).not.toBe('no_event_ids');
    expect(item!.unfetchableReason).not.toBe('partial_event_ids');
  });
});

describe('fetchPlanBuilder — daily completeness (non-latency)', () => {
  function makeConnectedGraph(paramId: string): Graph {
    return makeGraph({
      nodes: [
        { id: 'n1', label: 'From', event_id: 'from_event', x: 0, y: 0 },
        { id: 'n2', label: 'To', event_id: 'to_event', x: 100, y: 0 },
      ] as any,
      edges: [
        { id: 'e1', uuid: 'e1', from: 'n1', to: 'n2', p: { id: paramId, mean: 0.5, connection: 'amplitude-prod' } },
      ] as any,
    });
  }

  const connectedGraph = makeConnectedGraph('param-1');
  const dsl = 'window(1-Jan-26:31-Jan-26)';
  const windowJan: DateRange = { start: '1-Jan-26', end: '31-Jan-26' };

  it('treats same-day retrieval as incomplete and schedules refetch for that day', () => {
    const value: ParameterValue = {
      mean: 0.5,
      n: 10,
      k: 5,
      dates: ['1-Jan-26', '31-Jan-26'],
      n_daily: [10, 10],
      k_daily: [5, 5],
      window_from: '1-Jan-26',
      window_to: '31-Jan-26',
      sliceDSL: dsl,
      data_source: { type: 'api', retrieved_at: '2026-01-31T06:00:00Z' },
    };

    const fileState: FileStateAccessor = {
      getParameterFile: () => ({ data: { values: [value] } }),
      getCaseFile: () => undefined,
    };

    const { plan } = buildFetchPlan({
      graph: connectedGraph,
      dsl,
      window: windowJan,
      referenceNow: '2026-02-01T00:00:00.000Z',
      fileState,
      connectionChecker: alwaysConnected,
    });

    const item = plan.items.find(i => i.objectId === 'param-1');
    expect(item).toBeDefined();
    expect(item!.classification).toBe('fetch');
    expect(item!.windows).toEqual([
      { start: '31-Jan-26', end: '31-Jan-26', reason: 'stale', dayCount: 1 },
    ]);
  });

  it('treats next-day retrieval as complete and keeps the window covered', () => {
    const value: ParameterValue = {
      mean: 0.5,
      n: 10,
      k: 5,
      dates: ['1-Jan-26', '31-Jan-26'],
      n_daily: [10, 10],
      k_daily: [5, 5],
      window_from: '1-Jan-26',
      window_to: '31-Jan-26',
      sliceDSL: dsl,
      data_source: { type: 'api', retrieved_at: '2026-02-01T06:00:00Z' },
    };

    const fileState: FileStateAccessor = {
      getParameterFile: () => ({ data: { values: [value] } }),
      getCaseFile: () => undefined,
    };

    const { plan } = buildFetchPlan({
      graph: connectedGraph,
      dsl,
      window: windowJan,
      referenceNow: '2026-02-01T00:00:00.000Z',
      fileState,
      connectionChecker: alwaysConnected,
    });

    const item = plan.items.find(i => i.objectId === 'param-1');
    expect(item).toBeDefined();
    expect(item!.classification).toBe('covered');
    expect(item!.windows).toEqual([]);
  });
});
