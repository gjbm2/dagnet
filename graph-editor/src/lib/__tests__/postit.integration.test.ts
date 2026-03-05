/**
 * Post-it integration tests
 *
 * Covers: transform round-trip, subgraph extraction, paste with ID
 * remapping, and z-order array reordering.  These exercise the real
 * functions with real graph objects — no mocks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toFlow, fromFlow } from '../transform';
import { extractSubgraph, type ExtractedSubgraph } from '../subgraphExtractor';

// UpdateManager uses sessionLogService internally — stub the import
vi.mock('../../services/sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    startOperation: vi.fn(() => 'op-1'),
    addChild: vi.fn(),
    endOperation: vi.fn(),
  },
}));

// updateManager is a singleton; import after mocks are set up
const { updateManager } = await import('../../services/UpdateManager');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeGraph(overrides?: Partial<ReturnType<typeof makeGraph>>) {
  return {
    nodes: [
      { uuid: 'n1', id: 'start', label: 'Start', entry: { is_start: true }, layout: { x: 0, y: 0 } },
      { uuid: 'n2', id: 'end', label: 'End', absorbing: true, layout: { x: 200, y: 0 } },
    ],
    edges: [
      { uuid: 'e1', id: 'start->end', from: 'n1', to: 'n2', p: { mean: 1.0 } },
    ],
    policies: { default_outcome: 'end', overflow_policy: 'error' as const, free_edge_policy: 'complement' as const },
    metadata: { version: '1.0.0', created_at: '2026-01-01', updated_at: '2026-01-01T00:00:00Z' },
    postits: [
      { id: 'p1', text: 'Note A', colour: '#FFF475', width: 200, height: 150, x: 50, y: 300 },
      { id: 'p2', text: 'Note B', colour: '#F4BFDB', width: 180, height: 120, x: 100, y: 350 },
      { id: 'p3', text: 'Note C', colour: '#B6E3E9', width: 220, height: 160, x: 150, y: 400 },
    ],
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// 1. Selection routing — postit nodes vs conversion nodes in toFlow/fromFlow
// ---------------------------------------------------------------------------

describe('PostIt selection routing via toFlow', () => {
  it('should emit postit nodes with postit- prefix and conversion nodes without', () => {
    const graph = makeGraph();
    const { nodes } = toFlow(graph);

    const conversionNodes = nodes.filter(n => !n.id.startsWith('postit-'));
    const postitNodes = nodes.filter(n => n.id.startsWith('postit-'));

    expect(conversionNodes).toHaveLength(2);
    expect(postitNodes).toHaveLength(3);
    expect(postitNodes.map(n => n.id)).toEqual(['postit-p1', 'postit-p2', 'postit-p3']);
  });

  it('should allow selecting a postit by prefix without contaminating conversion nodes', () => {
    const graph = makeGraph();
    const { nodes } = toFlow(graph);

    const selectedPostitId = 'p2';
    const selectedRfNodeId = `postit-${selectedPostitId}`;
    const rfNode = nodes.find(n => n.id === selectedRfNodeId);

    expect(rfNode).toBeDefined();
    expect(rfNode!.type).toBe('postit');
    expect(rfNode!.data.postit.text).toBe('Note B');

    const isCanvasObject = (id: string) =>
      id.startsWith('postit-') || id.startsWith('container-') || id.startsWith('analysis-');

    const conversionSelection = nodes.filter(n => n.id === selectedRfNodeId && !isCanvasObject(n.id));
    expect(conversionSelection).toHaveLength(0);
  });

  it('should partition postit positions in fromFlow without affecting conversion node layout', () => {
    const graph = makeGraph();
    const { nodes, edges } = toFlow(graph);

    const movedNodes = nodes.map(n => {
      if (n.id === 'postit-p1') return { ...n, position: { x: 999, y: 888 } };
      if (n.id === 'n1') return { ...n, position: { x: 77, y: 66 } };
      return n;
    });

    const result = fromFlow(movedNodes, edges, graph);

    expect(result.nodes[0].layout.x).toBe(77);
    expect(result.nodes[0].layout.y).toBe(66);
    expect(result.nodes[1].layout.x).toBe(200);

    expect(result.postits[0].x).toBe(999);
    expect(result.postits[0].y).toBe(888);
    expect(result.postits[1].x).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 2. Delete — postit removal from graph.postits
// ---------------------------------------------------------------------------

describe('PostIt delete operations', () => {
  it('should remove a single postit by filtering graph.postits array', () => {
    const graph = makeGraph();
    const nextGraph = structuredClone(graph);
    nextGraph.postits = nextGraph.postits.filter((p: any) => p.id !== 'p2');

    expect(nextGraph.postits).toHaveLength(2);
    expect(nextGraph.postits.map((p: any) => p.id)).toEqual(['p1', 'p3']);
    expect(nextGraph.nodes).toHaveLength(2);
  });

  it('should handle mixed delete (conversion node + postit) independently', () => {
    const graph = makeGraph();
    const nextGraph = structuredClone(graph);

    const postitIdsToDelete = new Set(['p1']);
    const nodeUuidsToDelete = new Set(['n2']);

    nextGraph.postits = nextGraph.postits.filter((p: any) => !postitIdsToDelete.has(p.id));
    nextGraph.nodes = nextGraph.nodes.filter((n: any) => !nodeUuidsToDelete.has(n.uuid));
    nextGraph.edges = nextGraph.edges.filter((e: any) =>
      !nodeUuidsToDelete.has(e.from) && !nodeUuidsToDelete.has(e.to)
    );

    expect(nextGraph.postits).toHaveLength(2);
    expect(nextGraph.postits[0].id).toBe('p2');
    expect(nextGraph.nodes).toHaveLength(1);
    expect(nextGraph.nodes[0].uuid).toBe('n1');
    expect(nextGraph.edges).toHaveLength(0);
  });

  it('should preserve postits when only conversion nodes are deleted', () => {
    const graph = makeGraph();
    const nextGraph = structuredClone(graph);
    nextGraph.nodes = nextGraph.nodes.filter((n: any) => n.uuid !== 'n2');

    expect(nextGraph.postits).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Subgraph extraction — postit inclusion/exclusion
// ---------------------------------------------------------------------------

describe('PostIt subgraph extraction', () => {
  it('should include selected postits in extracted subgraph', () => {
    const graph = makeGraph();
    const result = extractSubgraph({
      selectedNodeIds: ['n1'],
      selectedPostitIds: ['p1', 'p3'],
      graph,
    });

    expect(result.postits).toHaveLength(2);
    expect(result.postits.map(p => p.id)).toEqual(['p1', 'p3']);
    expect(result.postits[0].text).toBe('Note A');
    expect(result.postits[1].text).toBe('Note C');
  });

  it('should return empty postits when no postit IDs are selected', () => {
    const graph = makeGraph();
    const result = extractSubgraph({
      selectedNodeIds: ['n1', 'n2'],
      graph,
    });

    expect(result.postits).toHaveLength(0);
  });

  it('should deep-clone postits so mutations do not affect the source graph', () => {
    const graph = makeGraph();
    const result = extractSubgraph({
      selectedNodeIds: [],
      selectedPostitIds: ['p2'],
      graph,
    });

    result.postits[0].text = 'MUTATED';
    expect(graph.postits![1].text).toBe('Note B');
  });

  it('should extract postits without nodes (postit-only copy)', () => {
    const graph = makeGraph();
    const result = extractSubgraph({
      selectedNodeIds: [],
      selectedPostitIds: ['p1'],
      graph,
    });

    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.postits).toHaveLength(1);
    expect(result.postits[0].id).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
// 4. Copy/paste — new UUID, offset position, preserve content
// ---------------------------------------------------------------------------

describe('PostIt paste via UpdateManager.pasteSubgraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should assign new UUIDs to pasted postits', () => {
    const graph = makeGraph();
    const extracted = extractSubgraph({
      selectedNodeIds: [],
      selectedPostitIds: ['p1'],
      graph,
    });

    const result = updateManager.pasteSubgraph(
      graph, extracted.nodes, extracted.edges, { x: 50, y: 50 }, extracted.postits
    );

    expect(result.pastedPostitIds).toHaveLength(1);
    const pastedId = result.pastedPostitIds[0];
    expect(pastedId).not.toBe('p1');
    expect(pastedId).toMatch(/^[0-9a-f]{8}-/);

    const pastedPostit = result.graph.postits.find((p: any) => p.id === pastedId);
    expect(pastedPostit).toBeDefined();
  });

  it('should offset pasted postit positions', () => {
    const graph = makeGraph();
    const extracted = extractSubgraph({
      selectedNodeIds: [],
      selectedPostitIds: ['p1'],
      graph,
    });

    const result = updateManager.pasteSubgraph(
      graph, extracted.nodes, extracted.edges, { x: 30, y: 40 }, extracted.postits
    );

    const pastedPostit = result.graph.postits.find(
      (p: any) => p.id === result.pastedPostitIds[0]
    );
    expect(pastedPostit.x).toBe(50 + 30);
    expect(pastedPostit.y).toBe(300 + 40);
  });

  it('should preserve text, colour, and dimensions on pasted postit', () => {
    const graph = makeGraph();
    const extracted = extractSubgraph({
      selectedNodeIds: [],
      selectedPostitIds: ['p2'],
      graph,
    });

    const result = updateManager.pasteSubgraph(
      graph, extracted.nodes, extracted.edges, { x: 0, y: 0 }, extracted.postits
    );

    const pastedPostit = result.graph.postits.find(
      (p: any) => p.id === result.pastedPostitIds[0]
    );
    expect(pastedPostit.text).toBe('Note B');
    expect(pastedPostit.colour).toBe('#F4BFDB');
    expect(pastedPostit.width).toBe(180);
    expect(pastedPostit.height).toBe(120);
  });

  it('should handle mixed paste (nodes + postits) with independent ID assignment', () => {
    const graph = makeGraph();
    const extracted = extractSubgraph({
      selectedNodeIds: ['n1'],
      selectedPostitIds: ['p3'],
      graph,
      includeConnectedEdges: false,
    });

    // extractSubgraph includes subsumed nodes (n2's only incoming edge is from n1)
    const extractedNodeCount = extracted.nodes.length;

    const result = updateManager.pasteSubgraph(
      graph, extracted.nodes, extracted.edges, { x: 10, y: 10 }, extracted.postits
    );

    expect(result.pastedNodeUuids).toHaveLength(extractedNodeCount);
    expect(result.pastedPostitIds).toHaveLength(1);
    expect(result.pastedPostitIds[0]).not.toBe('p3');

    expect(result.graph.nodes).toHaveLength(2 + extractedNodeCount);
    expect(result.graph.postits).toHaveLength(4);
  });

  it('should not mutate the source graph', () => {
    const graph = makeGraph();
    const graphBefore = structuredClone(graph);

    const extracted = extractSubgraph({
      selectedNodeIds: ['n1'],
      selectedPostitIds: ['p1', 'p2'],
      graph,
    });

    updateManager.pasteSubgraph(
      graph, extracted.nodes, extracted.edges, { x: 50, y: 50 }, extracted.postits
    );

    expect(graph.postits).toHaveLength(graphBefore.postits.length);
    expect(graph.nodes).toHaveLength(graphBefore.nodes.length);
  });
});

// ---------------------------------------------------------------------------
// 5. Z-order — array reordering controls visual stacking
// ---------------------------------------------------------------------------

describe('PostIt z-order via graph array position', () => {
  it('should place postit at end of array for bring-to-front', () => {
    const graph = makeGraph();
    const targetId = 'p1';

    const idx = graph.postits.findIndex((p: any) => p.id === targetId);
    const [removed] = graph.postits.splice(idx, 1);
    graph.postits.push(removed);

    expect(graph.postits.map((p: any) => p.id)).toEqual(['p2', 'p3', 'p1']);

    const { nodes } = toFlow(graph);
    const p1 = nodes.find(n => n.id === 'postit-p1')!;
    const p2 = nodes.find(n => n.id === 'postit-p2')!;
    const p3 = nodes.find(n => n.id === 'postit-p3')!;

    expect(p1.zIndex).toBeGreaterThan(p2.zIndex!);
    expect(p1.zIndex).toBeGreaterThan(p3.zIndex!);
  });

  it('should place postit at start of array for send-to-back', () => {
    const graph = makeGraph();
    const targetId = 'p3';

    const idx = graph.postits.findIndex((p: any) => p.id === targetId);
    const [removed] = graph.postits.splice(idx, 1);
    graph.postits.unshift(removed);

    expect(graph.postits.map((p: any) => p.id)).toEqual(['p3', 'p1', 'p2']);

    const { nodes } = toFlow(graph);
    const p3 = nodes.find(n => n.id === 'postit-p3')!;
    const p1 = nodes.find(n => n.id === 'postit-p1')!;
    const p2 = nodes.find(n => n.id === 'postit-p2')!;

    expect(p3.zIndex).toBeLessThan(p1.zIndex!);
    expect(p3.zIndex).toBeLessThan(p2.zIndex!);
  });

  it('should move postit one step forward for bring-forward', () => {
    const graph = makeGraph();
    const targetId = 'p1';

    const idx = graph.postits.findIndex((p: any) => p.id === targetId);
    if (idx < graph.postits.length - 1) {
      [graph.postits[idx], graph.postits[idx + 1]] = [graph.postits[idx + 1], graph.postits[idx]];
    }

    expect(graph.postits.map((p: any) => p.id)).toEqual(['p2', 'p1', 'p3']);

    const { nodes } = toFlow(graph);
    const p1 = nodes.find(n => n.id === 'postit-p1')!;
    const p2 = nodes.find(n => n.id === 'postit-p2')!;

    expect(p1.zIndex).toBeGreaterThan(p2.zIndex!);
  });

  it('should move postit one step backward for send-backward', () => {
    const graph = makeGraph();
    const targetId = 'p3';

    const idx = graph.postits.findIndex((p: any) => p.id === targetId);
    if (idx > 0) {
      [graph.postits[idx], graph.postits[idx - 1]] = [graph.postits[idx - 1], graph.postits[idx]];
    }

    expect(graph.postits.map((p: any) => p.id)).toEqual(['p1', 'p3', 'p2']);

    const { nodes } = toFlow(graph);
    const p3 = nodes.find(n => n.id === 'postit-p3')!;
    const p2 = nodes.find(n => n.id === 'postit-p2')!;

    expect(p3.zIndex).toBeLessThan(p2.zIndex!);
  });

  it('should emit postit nodes after conversion nodes for cross-type stacking', () => {
    const graph = makeGraph();
    const { nodes } = toFlow(graph);

    const lastConversionIdx = nodes.reduce(
      (max, n, i) => (n.type === 'conversion' ? i : max), -1
    );
    const firstPostitIdx = nodes.findIndex(n => n.type === 'postit');

    expect(firstPostitIdx).toBeGreaterThan(lastConversionIdx);
  });
});

// ---------------------------------------------------------------------------
// 6. Edge cases — undefined/empty postits, missing fields
// ---------------------------------------------------------------------------

describe('PostIt edge cases', () => {
  it('should handle graph with undefined postits gracefully in toFlow', () => {
    const graph = makeGraph({ postits: undefined });
    const { nodes } = toFlow(graph);
    const postitNodes = nodes.filter(n => n.id.startsWith('postit-'));
    expect(postitNodes).toHaveLength(0);
  });

  it('should handle graph with empty postits array in toFlow', () => {
    const graph = makeGraph({ postits: [] });
    const { nodes } = toFlow(graph);
    const postitNodes = nodes.filter(n => n.id.startsWith('postit-'));
    expect(postitNodes).toHaveLength(0);
  });

  it('should preserve postits in fromFlow when graph.postits exists but no RF postit nodes are present', () => {
    const graph = makeGraph();
    const conversionOnlyNodes = [
      { id: 'n1', type: 'conversion', position: { x: 0, y: 0 }, data: { layout: { x: 0, y: 0 } } },
      { id: 'n2', type: 'conversion', position: { x: 200, y: 0 }, data: { layout: { x: 200, y: 0 } } },
    ];

    const result = fromFlow(conversionOnlyNodes as any, [], graph);
    expect(result.postits).toHaveLength(3);
    expect(result.postits[0].text).toBe('Note A');
  });

  it('should not produce postits key in fromFlow when original graph has no postits', () => {
    const graph = makeGraph({ postits: undefined });
    delete (graph as any).postits;
    const { nodes, edges } = toFlow(graph);
    const result = fromFlow(nodes, edges, graph);
    expect(result.postits).toBeUndefined();
  });

  it('should handle extractSubgraph with nonexistent postit IDs gracefully', () => {
    const graph = makeGraph();
    const result = extractSubgraph({
      selectedNodeIds: [],
      selectedPostitIds: ['nonexistent-id'],
      graph,
    });
    expect(result.postits).toHaveLength(0);
  });

  it('should paste into a graph that has no existing postits array', () => {
    const graph = makeGraph({ postits: undefined });
    delete (graph as any).postits;

    const postit = { id: 'src-1', text: 'Hello', colour: '#FFF475', width: 200, height: 150, x: 10, y: 20 };
    const result = updateManager.pasteSubgraph(graph, [], [], { x: 5, y: 5 }, [postit]);

    expect(result.graph.postits).toHaveLength(1);
    expect(result.pastedPostitIds).toHaveLength(1);
    expect(result.graph.postits[0].text).toBe('Hello');
    expect(result.graph.postits[0].x).toBe(15);
    expect(result.graph.postits[0].y).toBe(25);
  });
});
