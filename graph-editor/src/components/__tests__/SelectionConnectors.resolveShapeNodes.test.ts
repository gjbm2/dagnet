/**
 * Tests for SelectionConnectors pure logic: findPath and resolveShapeNodes.
 *
 * These functions resolve a DSL string + graph topology into the node IDs
 * that should be highlighted (connected path, disconnected, referenced).
 * Correctness here prevents spurious node highlighting on canvas.
 */
import { describe, it, expect } from 'vitest';
import { findPath, resolveShapeNodes, getVisibleAnalysisIds, computeHaloNodeIds, topoSortWaypoints } from '../SelectionConnectors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a simple edge list and UUID→ID map from human-readable edges. */
function buildGraph(edges: Array<[string, string]>) {
  const graphEdges = edges.map(([from, to]) => ({ from, to }));
  // No UUID mapping needed — edges already use human IDs
  const nodeUuidToId = new Map<string, string>();
  return { graphEdges, nodeUuidToId };
}

/** Build graph with UUID-based edges and a UUID→ID mapping. */
function buildGraphWithUuids(
  nodes: Array<{ id: string; uuid: string }>,
  edges: Array<{ fromUuid: string; toUuid: string }>,
) {
  const graphEdges = edges.map(e => ({ from: e.fromUuid, to: e.toUuid }));
  const nodeUuidToId = new Map<string, string>();
  for (const n of nodes) nodeUuidToId.set(n.uuid, n.id);
  return { graphEdges, nodeUuidToId };
}

// ---------------------------------------------------------------------------
// findPath
// ---------------------------------------------------------------------------

describe('findPath', () => {
  it('finds a direct edge A→B', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B']]);
    expect(findPath('A', 'B', graphEdges, nodeUuidToId)).toEqual(['A', 'B']);
  });

  it('finds a multi-hop path A→B→C', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B'], ['B', 'C']]);
    expect(findPath('A', 'C', graphEdges, nodeUuidToId)).toEqual(['A', 'B', 'C']);
  });

  it('finds shortest path when multiple paths exist', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([
      ['A', 'B'], ['B', 'C'], ['A', 'C'],
    ]);
    // Direct A→C is shorter than A→B→C
    expect(findPath('A', 'C', graphEdges, nodeUuidToId)).toEqual(['A', 'C']);
  });

  it('returns null when no path exists', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B'], ['C', 'D']]);
    expect(findPath('A', 'D', graphEdges, nodeUuidToId)).toBeNull();
  });

  it('returns null for reverse direction (directed graph)', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B']]);
    expect(findPath('B', 'A', graphEdges, nodeUuidToId)).toBeNull();
  });

  it('handles UUID→ID mapping', () => {
    const { graphEdges, nodeUuidToId } = buildGraphWithUuids(
      [
        { id: 'node-a', uuid: 'uuid-a' },
        { id: 'node-b', uuid: 'uuid-b' },
        { id: 'node-c', uuid: 'uuid-c' },
      ],
      [
        { fromUuid: 'uuid-a', toUuid: 'uuid-b' },
        { fromUuid: 'uuid-b', toUuid: 'uuid-c' },
      ],
    );
    expect(findPath('node-a', 'node-c', graphEdges, nodeUuidToId)).toEqual(['node-a', 'node-b', 'node-c']);
  });

  it('handles self-loop (from === to)', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'A']]);
    // A is already the target — path is just [A]
    expect(findPath('A', 'A', graphEdges, nodeUuidToId)).toEqual(['A']);
  });
});

// ---------------------------------------------------------------------------
// resolveShapeNodes
// ---------------------------------------------------------------------------

describe('resolveShapeNodes', () => {
  it('from(A).to(B) with direct edge → connected path [A, B], both referenced', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B']]);
    const result = resolveShapeNodes('from(A).to(B)', graphEdges, nodeUuidToId);

    expect(result.connectedIds).toEqual(['A', 'B']);
    expect(result.disconnectedIds).toEqual([]);
    expect([...result.referencedOnPath]).toEqual(expect.arrayContaining(['A', 'B']));
    expect(result.referencedOnPath.size).toBe(2);
  });

  it('from(A).to(C) with path A→B→C → transit B is in connectedIds but NOT referenced', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B'], ['B', 'C']]);
    const result = resolveShapeNodes('from(A).to(C)', graphEdges, nodeUuidToId);

    expect(result.connectedIds).toEqual(['A', 'B', 'C']);
    expect(result.disconnectedIds).toEqual([]);
    // Only A and C are DSL-referenced — B is transit
    expect(result.referencedOnPath.has('A')).toBe(true);
    expect(result.referencedOnPath.has('C')).toBe(true);
    expect(result.referencedOnPath.has('B')).toBe(false);
  });

  it('from(A).to(C).visited(B) → B is also referenced', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B'], ['B', 'C']]);
    const result = resolveShapeNodes('from(A).to(C).visited(B)', graphEdges, nodeUuidToId);

    expect(result.connectedIds).toEqual(['A', 'B', 'C']);
    // B is explicitly visited — should be in referencedOnPath
    expect(result.referencedOnPath.has('B')).toBe(true);
    expect(result.referencedOnPath.has('A')).toBe(true);
    expect(result.referencedOnPath.has('C')).toBe(true);
  });

  it('from(A) only → disconnected [A]', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B']]);
    const result = resolveShapeNodes('from(A)', graphEdges, nodeUuidToId);

    expect(result.connectedIds).toEqual([]);
    expect(result.disconnectedIds).toEqual(['A']);
    expect(result.referencedOnPath.size).toBe(0);
  });

  it('to(B) only → disconnected [B]', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B']]);
    const result = resolveShapeNodes('to(B)', graphEdges, nodeUuidToId);

    expect(result.connectedIds).toEqual([]);
    expect(result.disconnectedIds).toEqual(['B']);
    expect(result.referencedOnPath.size).toBe(0);
  });

  it('from(A).to(D) with no path → both disconnected', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B'], ['C', 'D']]);
    const result = resolveShapeNodes('from(A).to(D)', graphEdges, nodeUuidToId);

    expect(result.connectedIds).toEqual([]);
    expect(result.disconnectedIds).toEqual(['A', 'D']);
    expect(result.referencedOnPath.size).toBe(0);
  });

  it('visited nodes unreachable in graph appear in disconnectedIds', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B']]);
    const result = resolveShapeNodes('from(A).to(B).visited(X)', graphEdges, nodeUuidToId);

    // A→B connected, X is visited but not reachable in the graph at all
    expect(result.connectedIds).toEqual(['A', 'B']);
    expect(result.disconnectedIds).toEqual(['X']);
    expect(result.referencedOnPath.has('A')).toBe(true);
    expect(result.referencedOnPath.has('B')).toBe(true);
    // X is disconnected — not in referencedOnPath
    expect(result.referencedOnPath.has('X')).toBe(false);
  });

  it('handles UUID-based graph edges', () => {
    const { graphEdges, nodeUuidToId } = buildGraphWithUuids(
      [
        { id: 'switch-registered', uuid: 'uuid-sr' },
        { id: 'switch-success', uuid: 'uuid-ss' },
      ],
      [{ fromUuid: 'uuid-sr', toUuid: 'uuid-ss' }],
    );
    const result = resolveShapeNodes(
      'from(switch-registered).to(switch-success)',
      graphEdges, nodeUuidToId,
    );

    expect(result.connectedIds).toEqual(['switch-registered', 'switch-success']);
    expect(result.referencedOnPath.has('switch-registered')).toBe(true);
    expect(result.referencedOnPath.has('switch-success')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// topoSortWaypoints
// ---------------------------------------------------------------------------

describe('topoSortWaypoints', () => {
  it('sorts waypoints in topological order of the graph', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B'], ['B', 'C'], ['C', 'D']]);
    const sorted = topoSortWaypoints(['D', 'A', 'C'], graphEdges, nodeUuidToId);
    expect(sorted).toEqual(['A', 'C', 'D']);
  });

  it('handles waypoints not in the graph — appends them at end', () => {
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B']]);
    const sorted = topoSortWaypoints(['A', 'X', 'B'], graphEdges, nodeUuidToId);
    expect(sorted.indexOf('A')).toBeLessThan(sorted.indexOf('B'));
    expect(sorted).toContain('X');
  });

  it('handles UUID-based edges', () => {
    const { graphEdges, nodeUuidToId } = buildGraphWithUuids(
      [
        { id: 'start', uuid: 'u1' },
        { id: 'mid', uuid: 'u2' },
        { id: 'end', uuid: 'u3' },
      ],
      [
        { fromUuid: 'u1', toUuid: 'u2' },
        { fromUuid: 'u2', toUuid: 'u3' },
      ],
    );
    const sorted = topoSortWaypoints(['end', 'start', 'mid'], graphEdges, nodeUuidToId);
    expect(sorted).toEqual(['start', 'mid', 'end']);
  });
});

// ---------------------------------------------------------------------------
// resolveShapeNodes — waypoint chaining
// ---------------------------------------------------------------------------

describe('resolveShapeNodes waypoint chaining', () => {
  it('chains visited node into connected path when reachable', () => {
    // Graph: A→B→C→D, visited(C) — old behaviour would BFS A→D (possibly A→B→C→D),
    // but if there were a shortcut A→D it would skip C. With chaining, C is a waypoint.
    const { graphEdges, nodeUuidToId } = buildGraph([
      ['A', 'B'], ['B', 'C'], ['C', 'D'], ['A', 'D'],
    ]);
    const result = resolveShapeNodes('from(A).to(D).visited(C)', graphEdges, nodeUuidToId);

    // C must be on the connected path, not disconnected
    expect(result.connectedIds).toContain('C');
    expect(result.disconnectedIds).not.toContain('C');
    // Path order: A before C, C before D
    expect(result.connectedIds.indexOf('A')).toBeLessThan(result.connectedIds.indexOf('C'));
    expect(result.connectedIds.indexOf('C')).toBeLessThan(result.connectedIds.indexOf('D'));
    expect(result.referencedOnPath.has('A')).toBe(true);
    expect(result.referencedOnPath.has('C')).toBe(true);
    expect(result.referencedOnPath.has('D')).toBe(true);
  });

  it('chains visitedAny nodes into connected path in topo order', () => {
    // Graph: A→B→C→D→E→F
    const { graphEdges, nodeUuidToId } = buildGraph([
      ['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'F'],
    ]);
    const result = resolveShapeNodes(
      'from(A).to(F).visited(B).visitedAny(C,D,E)',
      graphEdges, nodeUuidToId,
    );

    // All waypoints should be on the connected path in topo order
    expect(result.connectedIds).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(result.disconnectedIds).toEqual([]);
    for (const id of ['A', 'B', 'C', 'D', 'E', 'F']) {
      expect(result.referencedOnPath.has(id)).toBe(true);
    }
  });

  it('handles mixed reachable and unreachable visitedAny nodes', () => {
    // Graph: A→B→C, no path to X
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B'], ['B', 'C']]);
    const result = resolveShapeNodes(
      'from(A).to(C).visitedAny(B,X)',
      graphEdges, nodeUuidToId,
    );

    expect(result.connectedIds).toContain('A');
    expect(result.connectedIds).toContain('B');
    expect(result.connectedIds).toContain('C');
    expect(result.disconnectedIds).toContain('X');
  });

  it('real-world funnel: from→to with visited + visitedAny all on a linear chain', () => {
    // Simulates the user's actual funnel topology
    const { graphEdges, nodeUuidToId } = buildGraph([
      ['delegation', 'coffee'],
      ['coffee', 'classified'],
      ['classified', 'recommendation'],
      ['recommendation', 'registration'],
      ['registration', 'switch-success'],
      // Extra shortcut edges that BFS might prefer
      ['delegation', 'switch-success'],
      ['delegation', 'classified'],
    ]);
    const result = resolveShapeNodes(
      'from(delegation).to(switch-success).visited(coffee).visitedAny(classified,recommendation,registration)',
      graphEdges, nodeUuidToId,
    );

    // All funnel stages should be connected in topo order
    expect(result.disconnectedIds).toEqual([]);
    const ids = result.connectedIds;
    expect(ids.indexOf('delegation')).toBeLessThan(ids.indexOf('coffee'));
    expect(ids.indexOf('coffee')).toBeLessThan(ids.indexOf('classified'));
    expect(ids.indexOf('classified')).toBeLessThan(ids.indexOf('recommendation'));
    expect(ids.indexOf('recommendation')).toBeLessThan(ids.indexOf('registration'));
    expect(ids.indexOf('registration')).toBeLessThan(ids.indexOf('switch-success'));
  });

  it('from(A).to(D) with no path and waypoints → all disconnected', () => {
    // Two disconnected subgraphs
    const { graphEdges, nodeUuidToId } = buildGraph([['A', 'B'], ['C', 'D']]);
    const result = resolveShapeNodes(
      'from(A).to(D).visited(B)',
      graphEdges, nodeUuidToId,
    );

    // Can't chain A→B→?→D — at some point the chain breaks
    // All waypoints that can't be connected end up disconnected
    expect(result.connectedIds.length).toBeLessThan(4);
    expect(result.disconnectedIds.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getVisibleAnalysisIds — THREE triggers, ONE visibility set
// ---------------------------------------------------------------------------

describe('getVisibleAnalysisIds', () => {
  const analyses = [
    { id: 'a1', display: { show_subject_overlay: false } },
    { id: 'a2', display: { show_subject_overlay: true, subject_overlay_colour: '#ff0000' } },
    { id: 'a3' },
    { id: 'a4', display: { show_subject_overlay: false } },
  ];

  it('selected analysis is visible', () => {
    const ids = getVisibleAnalysisIds(analyses, 'a1', null);
    expect(ids.has('a1')).toBe(true);
  });

  it('dragged analysis is visible', () => {
    const ids = getVisibleAnalysisIds(analyses, null, 'a3');
    expect(ids.has('a3')).toBe(true);
  });

  it('persisted overlay analysis is visible', () => {
    const ids = getVisibleAnalysisIds(analyses, null, null);
    expect(ids.has('a2')).toBe(true);
  });

  it('non-selected, non-dragged, non-persisted analyses are NOT visible', () => {
    const ids = getVisibleAnalysisIds(analyses, 'a1', null);
    expect(ids.has('a3')).toBe(false);
    expect(ids.has('a4')).toBe(false);
  });

  it('all three triggers combine into one set', () => {
    const ids = getVisibleAnalysisIds(analyses, 'a1', 'a3');
    expect(ids.has('a1')).toBe(true);  // selected
    expect(ids.has('a2')).toBe(true);  // persisted
    expect(ids.has('a3')).toBe(true);  // dragged
    expect(ids.has('a4')).toBe(false); // none of the above
  });

  it('dragged and selected can be the same analysis', () => {
    const ids = getVisibleAnalysisIds(analyses, 'a1', 'a1');
    expect(ids.has('a1')).toBe(true);
    expect(ids.size).toBe(2); // a1 + a2 (persisted)
  });

  it('no triggers → only persisted overlays visible', () => {
    const ids = getVisibleAnalysisIds(analyses, null, null);
    expect(ids.size).toBe(1);
    expect(ids.has('a2')).toBe(true);
  });

  it('empty analyses list → empty set', () => {
    const ids = getVisibleAnalysisIds([], 'a1', 'a3');
    expect(ids.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeHaloNodeIds — every visible shape contributes equally
// ---------------------------------------------------------------------------

describe('computeHaloNodeIds', () => {
  it('maps node IDs to their shape colours', () => {
    const shapes = [
      { referencedNodeIds: ['n1', 'n2'], colour: '#ff0000' },
    ];
    const map = computeHaloNodeIds(shapes);
    expect(map.get('n1')).toEqual(['#ff0000']);
    expect(map.get('n2')).toEqual(['#ff0000']);
  });

  it('multiple shapes referencing same node → multiple colours', () => {
    const shapes = [
      { referencedNodeIds: ['n1'], colour: '#ff0000' },
      { referencedNodeIds: ['n1'], colour: '#00ff00' },
    ];
    const map = computeHaloNodeIds(shapes);
    expect(map.get('n1')).toEqual(['#ff0000', '#00ff00']);
  });

  it('same colour from multiple shapes is not duplicated', () => {
    const shapes = [
      { referencedNodeIds: ['n1'], colour: '#ff0000' },
      { referencedNodeIds: ['n1'], colour: '#ff0000' },
    ];
    const map = computeHaloNodeIds(shapes);
    expect(map.get('n1')).toEqual(['#ff0000']);
  });

  it('empty shapes → empty map', () => {
    const map = computeHaloNodeIds([]);
    expect(map.size).toBe(0);
  });
});
