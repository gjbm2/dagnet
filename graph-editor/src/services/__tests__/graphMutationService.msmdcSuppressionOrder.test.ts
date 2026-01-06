/**
 * Regression test: MSMDC apply must suppress file→store sync BEFORE writing updated graph to store.
 *
 * This guards against a race where stale FileRegistry data overwrites graph-mastered fields
 * (notably `p.latency.anchor_node_id`) immediately after MSMDC applies updates.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
  },
}));

vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    getDiagnosticLoggingEnabled: vi.fn(() => false),
    startOperation: vi.fn(() => 'op-1'),
    addChild: vi.fn(),
    endOperation: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../queryRegenerationService', () => ({
  queryRegenerationService: {
    regenerateQueries: vi.fn(async () => ({
      parameters: [],
      anchors: {},
      graphUpdates: 0,
      fileUpdates: 0,
    })),
    applyRegeneratedQueries: vi.fn(async () => ({
      graphUpdates: 1,
      fileUpdates: 0,
      skipped: 0,
      fileCascadeDecisions: [],
      changedParameters: [],
      changedAnchors: [],
      changedNQueries: [],
    })),
  },
}));

const { graphMutationService } = await import('../graphMutationService');

describe('graphMutationService MSMDC apply ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches dagnet:suppressFileToStoreSync before setGraph(updatedGraph)', async () => {
    const originalWindow = (globalThis as any).window;
    const originalCustomEvent = (globalThis as any).CustomEvent;

    // Minimal stubs so the service can call `window.dispatchEvent(new CustomEvent(...))` in Node.
    const dispatchEvent = vi.fn((event: any) => {
      // Mirror browser dispatchEvent signature (boolean return), but we don’t use it.
      return true;
    });
    (globalThis as any).window = { dispatchEvent };
    (globalThis as any).CustomEvent = class CustomEvent<T = any> {
      type: string;
      detail: T | undefined;
      constructor(type: string, init?: { detail?: T }) {
        this.type = type;
        this.detail = init?.detail;
      }
    };

    const setGraph = vi.fn();

    const graph: any = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'a', layout: { x: 0, y: 0 } },
        { id: 'B', uuid: 'B', label: 'B', event_id: 'b', layout: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', uuid: 'e1', from: 'A', to: 'B', p: { id: 'p1', latency: {} } },
      ],
      metadata: { version: '1.0.0', created_at: '2026-01-06T10:00:00.000Z' },
    };

    try {
      await (graphMutationService as any).regenerateQueriesAsync(graph, setGraph, {
        downstreamOf: undefined,
        literalWeights: { visited: 10, exclude: 1 },
      });
    } finally {
      (globalThis as any).window = originalWindow;
      (globalThis as any).CustomEvent = originalCustomEvent;
    }

    // Ensure we emitted the suppression event and then wrote to the store.
    expect(dispatchEvent).toHaveBeenCalled();
    expect(setGraph).toHaveBeenCalledTimes(1);

    const firstEvent = dispatchEvent.mock.calls.find(c => (c[0] as any).type === 'dagnet:suppressFileToStoreSync');
    expect(firstEvent).toBeTruthy();

    const eventCallIndex = dispatchEvent.mock.calls.findIndex(c => (c[0] as any).type === 'dagnet:suppressFileToStoreSync');
    const eventCallOrder = dispatchEvent.mock.invocationCallOrder[eventCallIndex];
    const setGraphCallOrder = setGraph.mock.invocationCallOrder[0];

    expect(eventCallOrder).toBeLessThan(setGraphCallOrder);
  });
});


