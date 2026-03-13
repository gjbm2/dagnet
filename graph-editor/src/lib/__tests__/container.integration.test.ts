/**
 * Container integration tests
 *
 * Covers: transform round-trip, containment logic, halo colour, copy/paste, z-order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toFlow, fromFlow } from '../transform';
import { extractSubgraph } from '../subgraphExtractor';

vi.mock('../../services/sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(),
    startOperation: vi.fn(() => 'op-1'), addChild: vi.fn(), endOperation: vi.fn(),
  },
}));

const { updateManager } = await import('../../services/UpdateManager');

function makeGraph(overrides?: any) {
  return {
    nodes: [
      { uuid: 'n1', id: 'start', label: 'Start', entry: { is_start: true }, layout: { x: 100, y: 100 } },
      { uuid: 'n2', id: 'end', label: 'End', absorbing: true, layout: { x: 200, y: 100 } },
    ],
    edges: [
      { uuid: 'e1', id: 'start->end', from: 'n1', to: 'n2', p: { mean: 1.0 } },
    ],
    policies: { default_outcome: 'end', overflow_policy: 'error' as const, free_edge_policy: 'complement' as const },
    metadata: { version: '1.0.0', created_at: '2026-01-01', updated_at: '2026-01-01T00:00:00Z' },
    containers: [
      { id: 'c1', label: 'Group A', colour: '#94A3B8', width: 400, height: 300, x: 50, y: 50 },
      { id: 'c2', label: 'Group B', colour: '#86EFAC', width: 200, height: 150, x: 500, y: 200 },
    ],
    postits: [
      { id: 'p1', text: 'Note', colour: '#FFF475', width: 200, height: 150, x: 80, y: 80 },
    ],
    ...overrides,
  } as any;
}

describe('Container transform: toFlow', () => {
  it('should emit container nodes with container- prefix and type', () => {
    const { nodes } = toFlow(makeGraph());
    const containerNodes = nodes.filter(n => n.id?.startsWith('container-'));
    expect(containerNodes).toHaveLength(2);
    expect(containerNodes[0].id).toBe('container-c1');
    expect(containerNodes[0].type).toBe('container');
    expect(containerNodes[0].data.container.label).toBe('Group A');
  });

  it('should place containers before conversion nodes in DOM order (containers paint underneath)', () => {
    const { nodes } = toFlow(makeGraph());
    const lastContainerIdx = nodes.reduce((max, n, i) => n.type === 'container' ? i : max, -1);
    const firstConversionIdx = nodes.findIndex(n => n.type === 'conversion');
    const firstPostitIdx = nodes.findIndex(n => n.type === 'postit');

    expect(lastContainerIdx).toBeLessThan(firstConversionIdx);
    expect(firstPostitIdx).toBeGreaterThan(firstConversionIdx);
  });

  it('should handle undefined containers gracefully', () => {
    const { nodes } = toFlow(makeGraph({ containers: undefined }));
    expect(nodes.filter(n => n.id?.startsWith('container-'))).toHaveLength(0);
  });

  it('should assign incrementing zIndex based on array order', () => {
    const { nodes } = toFlow(makeGraph());
    const c1 = nodes.find(n => n.id === 'container-c1')!;
    const c2 = nodes.find(n => n.id === 'container-c2')!;
    expect(c1.zIndex).toBe(1000);
    expect(c2.zIndex).toBe(1001);
  });
});

describe('Container transform: fromFlow', () => {
  it('should update container positions from ReactFlow state', () => {
    const graph = makeGraph();
    const { nodes, edges } = toFlow(graph);

    const movedNodes = nodes.map(n =>
      n.id === 'container-c1' ? { ...n, position: { x: 999, y: 888 } } : n
    );
    const result = fromFlow(movedNodes, edges, graph);

    expect(result.containers[0].x).toBe(999);
    expect(result.containers[0].y).toBe(888);
    expect(result.containers[1].x).toBe(500);
  });

  it('should not contaminate conversion nodes with container data', () => {
    const graph = makeGraph();
    const { nodes, edges } = toFlow(graph);
    const result = fromFlow(nodes, edges, graph);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].uuid).toBe('n1');
    expect(result.containers).toHaveLength(2);
  });

  it('should preserve containers when no RF container nodes exist', () => {
    const graph = makeGraph();
    const conversionOnly = [
      { id: 'n1', type: 'conversion', position: { x: 0, y: 0 }, data: { layout: { x: 0, y: 0 } } },
      { id: 'n2', type: 'conversion', position: { x: 200, y: 0 }, data: { layout: { x: 200, y: 0 } } },
    ];
    const result = fromFlow(conversionOnly as any, [], graph);
    expect(result.containers).toHaveLength(2);
  });
});

describe('Container colour for halo adaptation', () => {
  it('toFlow does not inject containerColours (computed at render time in GraphCanvas)', () => {
    const graph = makeGraph();
    const { nodes } = toFlow(graph);
    const n1 = nodes.find(n => n.id === 'n1')!;
    expect(n1.data.containerColours).toBeUndefined();
  });
});

describe('Container subgraph extraction', () => {
  it('should include selected containers in extracted subgraph', () => {
    const graph = makeGraph();
    const result = extractSubgraph({
      selectedNodeIds: [],
      selectedCanvasObjectIds: { containers: ['c1'] },
      graph,
    });
    expect(result.containers).toHaveLength(1);
    expect(result.containers[0].id).toBe('c1');
    expect(result.containers[0].label).toBe('Group A');
  });

  it('should extract mixed selection (nodes + containers + postits)', () => {
    const graph = makeGraph();
    const result = extractSubgraph({
      selectedNodeIds: ['n1'],
      selectedCanvasObjectIds: { containers: ['c2'], postits: ['p1'] },
      graph,
    });
    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    expect(result.containers).toHaveLength(1);
    expect(result.postits).toHaveLength(1);
  });
});

describe('Container paste via UpdateManager', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should assign new UUID and offset position to pasted container', () => {
    const graph = makeGraph();
    const extracted = extractSubgraph({
      selectedNodeIds: [],
      selectedCanvasObjectIds: { containers: ['c1'] },
      graph,
    });

    const result = updateManager.pasteSubgraph(
      graph, extracted.nodes, extracted.edges, { x: 30, y: 40 },
      extracted.postits, { containers: extracted.containers }
    );

    const pastedIds = result.pastedCanvasObjectIds['containers'] || [];
    expect(pastedIds).toHaveLength(1);
    expect(pastedIds[0]).not.toBe('c1');

    const pasted = result.graph.containers.find((c: any) => c.id === pastedIds[0]);
    expect(pasted.x).toBe(50 + 30);
    expect(pasted.y).toBe(50 + 40);
    expect(pasted.label).toBe('Group A');
    expect(pasted.colour).toBe('#94A3B8');
  });

  it('should not mutate source graph', () => {
    const graph = makeGraph();
    const before = structuredClone(graph);
    const extracted = extractSubgraph({
      selectedNodeIds: [],
      selectedCanvasObjectIds: { containers: ['c1'] },
      graph,
    });
    updateManager.pasteSubgraph(graph, [], [], { x: 0, y: 0 }, undefined, { containers: extracted.containers });
    expect(graph.containers).toHaveLength(before.containers.length);
  });
});

describe('Container z-order via graph array position', () => {
  it('should reflect array order in zIndex (bring-to-front)', () => {
    const graph = makeGraph();
    // Move c1 to end (bring to front)
    const reordered = { ...graph, containers: [graph.containers[1], graph.containers[0]] };
    const { nodes } = toFlow(reordered);

    const c1 = nodes.find(n => n.id === 'container-c1')!;
    const c2 = nodes.find(n => n.id === 'container-c2')!;
    expect(c1.zIndex).toBeGreaterThan(c2.zIndex!);
  });
});

describe('Container edge cases', () => {
  it('should handle graph with empty containers array', () => {
    const { nodes } = toFlow(makeGraph({ containers: [] }));
    expect(nodes.filter(n => n.id?.startsWith('container-'))).toHaveLength(0);
  });

  it('should paste into graph with no existing containers array', () => {
    const graph = makeGraph({ containers: undefined });
    delete (graph as any).containers;
    const container = { id: 'src', label: 'Test', colour: '#94A3B8', width: 400, height: 300, x: 10, y: 20 };
    const result = updateManager.pasteSubgraph(graph, [], [], { x: 5, y: 5 }, undefined, { containers: [container] });
    expect(result.graph.containers).toHaveLength(1);
    expect(result.graph.containers[0].x).toBe(15);
  });
});

// ============================================================================
// Container + contents: full copy-paste round-trip
// ============================================================================

function makeRichGraph() {
  return {
    nodes: [
      { uuid: 'n1', id: 'start', label: 'Start', entry: { is_start: true }, layout: { x: 100, y: 100 } },
      { uuid: 'n2', id: 'end', label: 'End', absorbing: true, layout: { x: 300, y: 100 } },
      { uuid: 'n3', id: 'outside', label: 'Outside', layout: { x: 800, y: 800 } },
    ],
    edges: [
      {
        uuid: 'e1', id: 'start-to-end', from: 'n1', to: 'n2',
        query: 'from(start).to(end)',
        n_query: 'n.from(start)',
        p: {
          mean: 0.5,
          query: 'from(start)',
          n_query: 'n.from(start)',
          latency: { anchor_node_id: 'start', t95: 7 },
        },
        conditional_p: [
          { condition: 'from(start).to(end)', p: { mean: 0.8 } },
        ],
      },
    ],
    policies: { default_outcome: 'end', overflow_policy: 'error' as const, free_edge_policy: 'complement' as const },
    metadata: { version: '1.0.0', created_at: '2026-01-01', updated_at: '2026-01-01T00:00:00Z' },
    containers: [
      { id: 'c1', label: 'Group', colour: '#94A3B8', width: 400, height: 300, x: 50, y: 50 },
    ],
    postits: [
      { id: 'p1', text: 'Note', colour: '#FFF475', width: 200, height: 150, x: 80, y: 80 },
    ],
  } as any;
}

describe('Container + contents paste: ID uniqueness', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should assign unique IDs to all pasted items (container, nodes, edges, postits)', () => {
    const graph = makeRichGraph();
    const extracted = extractSubgraph({
      selectedNodeIds: ['n1', 'n2'],
      selectedCanvasObjectIds: { containers: ['c1'], postits: ['p1'] },
      graph,
      includeConnectedEdges: true,
    });

    const result = updateManager.pasteSubgraph(
      graph, extracted.nodes, extracted.edges, { x: 50, y: 50 },
      extracted.postits, { containers: extracted.containers }
    );

    // Node UUIDs must differ from originals
    expect(result.pastedNodeUuids).toHaveLength(2);
    for (const uuid of result.pastedNodeUuids) {
      expect(uuid).not.toBe('n1');
      expect(uuid).not.toBe('n2');
    }

    // Node human-readable IDs must differ from originals
    const pastedNodes = result.graph.nodes.filter((n: any) => result.pastedNodeUuids.includes(n.uuid));
    for (const node of pastedNodes) {
      expect(node.id).not.toBe('start');
      expect(node.id).not.toBe('end');
    }

    // Edge UUIDs must differ
    expect(result.pastedEdgeUuids).toHaveLength(1);
    expect(result.pastedEdgeUuids[0]).not.toBe('e1');

    // Container IDs must differ
    const pastedContainerIds = result.pastedCanvasObjectIds['containers'] || [];
    expect(pastedContainerIds).toHaveLength(1);
    expect(pastedContainerIds[0]).not.toBe('c1');

    // Post-it IDs must differ
    expect(result.pastedPostitIds).toHaveLength(1);
    expect(result.pastedPostitIds[0]).not.toBe('p1');

    // Total counts: originals + pasted
    expect(result.graph.nodes).toHaveLength(3 + 2);
    expect(result.graph.edges).toHaveLength(1 + 1);
    expect(result.graph.containers).toHaveLength(1 + 1);
    expect(result.graph.postits).toHaveLength(1 + 1);
  });
});

describe('Container + contents paste: position offset', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should apply offset to node layout.x/y, container x/y, and postit x/y coherently', () => {
    const graph = makeRichGraph();
    const extracted = extractSubgraph({
      selectedNodeIds: ['n1', 'n2'],
      selectedCanvasObjectIds: { containers: ['c1'], postits: ['p1'] },
      graph,
      includeConnectedEdges: true,
    });

    const offset = { x: 60, y: 70 };
    const result = updateManager.pasteSubgraph(
      graph, extracted.nodes, extracted.edges, offset,
      extracted.postits, { containers: extracted.containers }
    );

    // Nodes — check layout.x/y offset
    const pastedNodes = result.graph.nodes.filter((n: any) => result.pastedNodeUuids.includes(n.uuid));
    const n1Clone = pastedNodes.find((n: any) => n.id.startsWith('start'));
    const n2Clone = pastedNodes.find((n: any) => n.id.startsWith('end'));
    expect(n1Clone.layout.x).toBe(100 + offset.x);
    expect(n1Clone.layout.y).toBe(100 + offset.y);
    expect(n2Clone.layout.x).toBe(300 + offset.x);
    expect(n2Clone.layout.y).toBe(100 + offset.y);

    // Container — check x/y offset
    const pastedContainerId = result.pastedCanvasObjectIds['containers'][0];
    const pastedContainer = result.graph.containers.find((c: any) => c.id === pastedContainerId);
    expect(pastedContainer.x).toBe(50 + offset.x);
    expect(pastedContainer.y).toBe(50 + offset.y);

    // Post-it — check x/y offset
    const pastedPostitId = result.pastedPostitIds[0];
    const pastedPostit = result.graph.postits.find((p: any) => p.id === pastedPostitId);
    expect(pastedPostit.x).toBe(80 + offset.x);
    expect(pastedPostit.y).toBe(80 + offset.y);

    // Relative positions preserved: container-to-node spacing is the same
    const origNodeRelX = 100 - 50; // node.layout.x - container.x
    const pastedNodeRelX = n1Clone.layout.x - pastedContainer.x;
    expect(pastedNodeRelX).toBe(origNodeRelX);
  });
});

describe('Container + contents paste: edge reference remapping', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should remap edge from/to to new node UUIDs', () => {
    const graph = makeRichGraph();
    const extracted = extractSubgraph({
      selectedNodeIds: ['n1', 'n2'],
      selectedCanvasObjectIds: { containers: ['c1'] },
      graph,
      includeConnectedEdges: true,
    });

    const result = updateManager.pasteSubgraph(
      graph, extracted.nodes, extracted.edges, { x: 50, y: 50 },
      undefined, { containers: extracted.containers }
    );

    const pastedEdge = result.graph.edges.find((e: any) => e.uuid === result.pastedEdgeUuids[0]);
    // from/to must be the new node UUIDs, not originals
    expect(result.pastedNodeUuids).toContain(pastedEdge.from);
    expect(result.pastedNodeUuids).toContain(pastedEdge.to);
    expect(pastedEdge.from).not.toBe('n1');
    expect(pastedEdge.to).not.toBe('n2');
  });

  it('should remap edge.query and edge.n_query to new node IDs', () => {
    const graph = makeRichGraph();
    const extracted = extractSubgraph({
      selectedNodeIds: ['n1', 'n2'],
      selectedCanvasObjectIds: {},
      graph,
      includeConnectedEdges: true,
    });

    const result = updateManager.pasteSubgraph(
      graph, extracted.nodes, extracted.edges, { x: 50, y: 50 }
    );

    const pastedEdge = result.graph.edges.find((e: any) => e.uuid === result.pastedEdgeUuids[0]);
    // New node IDs will have a suffix like 'start-1', 'end-1'
    const pastedNodes = result.graph.nodes.filter((n: any) => result.pastedNodeUuids.includes(n.uuid));
    const newStartId = pastedNodes.find((n: any) => n.id.startsWith('start'))!.id;
    const newEndId = pastedNodes.find((n: any) => n.id.startsWith('end'))!.id;

    expect(pastedEdge.query).toContain(newStartId);
    expect(pastedEdge.query).toContain(newEndId);
    expect(pastedEdge.query).not.toContain('from(start).');  // original 'start' replaced
    expect(pastedEdge.n_query).toContain(newStartId);
  });

  it('should remap conditional_p conditions to new node IDs', () => {
    const graph = makeRichGraph();
    const extracted = extractSubgraph({
      selectedNodeIds: ['n1', 'n2'],
      selectedCanvasObjectIds: {},
      graph,
      includeConnectedEdges: true,
    });

    const result = updateManager.pasteSubgraph(
      graph, extracted.nodes, extracted.edges, { x: 50, y: 50 }
    );

    const pastedEdge = result.graph.edges.find((e: any) => e.uuid === result.pastedEdgeUuids[0]);
    const pastedNodes = result.graph.nodes.filter((n: any) => result.pastedNodeUuids.includes(n.uuid));
    const newStartId = pastedNodes.find((n: any) => n.id.startsWith('start'))!.id;

    expect(pastedEdge.conditional_p[0].condition).toContain(newStartId);
    expect(pastedEdge.conditional_p[0].condition).not.toBe('from(start).to(end)');
  });

  it('should remap edge.p.query, edge.p.n_query, and edge.p.latency.anchor_node_id', () => {
    const graph = makeRichGraph();
    const extracted = extractSubgraph({
      selectedNodeIds: ['n1', 'n2'],
      selectedCanvasObjectIds: {},
      graph,
      includeConnectedEdges: true,
    });

    const result = updateManager.pasteSubgraph(
      graph, extracted.nodes, extracted.edges, { x: 50, y: 50 }
    );

    const pastedEdge = result.graph.edges.find((e: any) => e.uuid === result.pastedEdgeUuids[0]);
    const pastedNodes = result.graph.nodes.filter((n: any) => result.pastedNodeUuids.includes(n.uuid));
    const newStartId = pastedNodes.find((n: any) => n.id.startsWith('start'))!.id;

    // p.query and p.n_query remapped
    expect(pastedEdge.p.query).toContain(newStartId);
    expect(pastedEdge.p.query).not.toBe('from(start)');
    expect(pastedEdge.p.n_query).toContain(newStartId);

    // anchor_node_id remapped — original was 'start', should now be new ID
    expect(pastedEdge.p.latency.anchor_node_id).not.toBe('start');
  });
});

describe('Container + contents paste: double-paste accumulation', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should produce unique IDs across two successive pastes of the same clipboard', () => {
    const graph = makeRichGraph();
    const extracted = extractSubgraph({
      selectedNodeIds: ['n1', 'n2'],
      selectedCanvasObjectIds: { containers: ['c1'] },
      graph,
      includeConnectedEdges: true,
    });

    // First paste
    const r1 = updateManager.pasteSubgraph(
      graph, extracted.nodes, extracted.edges, { x: 50, y: 50 },
      undefined, { containers: extracted.containers }
    );

    // Second paste into the result of the first
    const r2 = updateManager.pasteSubgraph(
      r1.graph, extracted.nodes, extracted.edges, { x: 100, y: 100 },
      undefined, { containers: extracted.containers }
    );

    // All node UUIDs must be distinct
    const allNodeUuids = r2.graph.nodes.map((n: any) => n.uuid);
    expect(new Set(allNodeUuids).size).toBe(allNodeUuids.length);

    // All node human-readable IDs must be distinct
    const allNodeIds = r2.graph.nodes.map((n: any) => n.id).filter(Boolean);
    expect(new Set(allNodeIds).size).toBe(allNodeIds.length);

    // All edge UUIDs must be distinct
    const allEdgeUuids = r2.graph.edges.map((e: any) => e.uuid);
    expect(new Set(allEdgeUuids).size).toBe(allEdgeUuids.length);

    // All container IDs must be distinct
    const allContainerIds = r2.graph.containers.map((c: any) => c.id);
    expect(new Set(allContainerIds).size).toBe(allContainerIds.length);

    // 3 originals + 2 from paste 1 + 2 from paste 2
    expect(r2.graph.nodes).toHaveLength(3 + 2 + 2);
    expect(r2.graph.containers).toHaveLength(1 + 1 + 1);
  });
});
