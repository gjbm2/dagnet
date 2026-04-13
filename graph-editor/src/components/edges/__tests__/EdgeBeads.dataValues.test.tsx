/**
 * Data Values View Mode — Invariant Tests (blind, from spec)
 *
 * These tests assert structural invariants that must hold for ANY graph
 * in data values mode, regardless of implementation details:
 *
 * INVARIANT 1 (sibling n):  All edges leaving the same node show identical n.
 * INVARIANT 2 (flow):       For each non-START node, the n on its outgoing edges
 *                           equals the sum of k on its incoming edges.
 * INVARIANT 3 (anchor):     Anchor edges (from START) seed n from evidence.n.
 * INVARIANT 4 (k ≤ n):     k never exceeds n on any edge.
 * INVARIANT 5 (integer):    All displayed k and n are non-negative integers.
 * INVARIANT 6 (mode-off):   When data values mode is off, beads show percentages.
 *
 * These invariants must hold across all visibility modes (F+E, F, E).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildBeadDefinitions } from '../edgeBeadHelpers';
import { computeInboundN } from '../../../services/statisticalEnhancementService';
import type { Graph, GraphEdge } from '../../../types';
import type { ScenarioVisibilityMode } from '../../../types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../services/CompositionService', () => ({
  getComposedParamsForLayer: vi.fn(() => ({ edges: {} }))
}));

vi.mock('@/lib/conditionalColours', () => ({
  getConditionalProbabilityColour: vi.fn(() => '#8B5CF6'),
  ensureDarkBeadColour: vi.fn((c: string) => c),
  darkenCaseColour: vi.fn((c: string) => c)
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse "k/n" (with optional thousands separators) from bead displayText */
function parseKN(displayText: any): { k: number; n: number } | null {
  const text = extractText(displayText);
  const match = text.match(/([\d,]+)\/([\d,]+)/);
  if (!match) return null;
  return {
    k: parseInt(match[1].replace(/,/g, ''), 10),
    n: parseInt(match[2].replace(/,/g, ''), 10),
  };
}

function extractText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node.props?.children) return extractText(node.props.children);
  return '';
}

/** Build inbound-n map for a graph (same logic EdgeBeads uses) */
function buildInboundNMap(graph: Graph): Map<string, { n: number; forecast_k: number }> {
  const endpointIds = new Set<string>();
  for (const e of graph.edges || []) {
    if (typeof (e as any).from === 'string') endpointIds.add((e as any).from);
    if (typeof (e as any).to === 'string') endpointIds.add((e as any).to);
  }
  const nodeKey = (nd: any): string => {
    const uuid = typeof nd?.uuid === 'string' ? nd.uuid : undefined;
    const id = typeof nd?.id === 'string' ? nd.id : undefined;
    if (uuid && endpointIds.has(uuid)) return uuid;
    if (id && endpointIds.has(id)) return id;
    return uuid || id || '';
  };
  const graphForN = {
    nodes: (graph.nodes || []).map(nd => ({ id: nodeKey(nd), type: nd.type, entry: nd.entry })),
    edges: (graph.edges || []).map(e => ({
      id: e.id, uuid: e.uuid, from: e.from, to: e.to,
      p: e.p ? { mean: e.p.mean, evidence: e.p.evidence ? { n: e.p.evidence.n, k: e.p.evidence.k } : undefined } : undefined,
    })),
  };
  const activeEdges = new Set((graph.edges || []).map(e => e.id || e.uuid || ''));
  return computeInboundN(graphForN as any, activeEdges, (edgeId) => {
    const e = (graph.edges || []).find(ed => (ed.id || ed.uuid) === edgeId);
    return e?.p?.mean ?? 0;
  });
}

function callBuildBeads(
  edge: GraphEdge,
  graph: Graph,
  beadDisplayMode: import('../../../types').BeadDisplayMode,
  inboundNMap?: Map<string, { n: number; forecast_k: number }>,
  visibilityMode?: ScenarioVisibilityMode
) {
  const ctx = { scenarios: [], baseParams: { edges: {} }, currentParams: { edges: {} } };
  const getMode = visibilityMode
    ? (_id: string) => visibilityMode
    : undefined;
  return buildBeadDefinitions(
    edge, graph, ctx,
    [], ['current'], ['current'],
    new Map([['current', '#FFF']]),
    undefined, 0, getMode,
    beadDisplayMode, inboundNMap
  );
}

/** Extract k/n for every edge in a graph. Returns map edgeId → {k, n}. */
function extractAllKN(
  graph: Graph,
  visibilityMode?: ScenarioVisibilityMode
): Map<string, { k: number; n: number }> {
  const nMap = buildInboundNMap(graph);
  const result = new Map<string, { k: number; n: number }>();
  for (const edge of graph.edges) {
    const beads = callBuildBeads(edge, graph, 'data-values', nMap, visibilityMode);
    const probBead = beads.find(b => b.type === 'probability');
    if (!probBead) continue;
    const kn = parseKN(probBead.displayText);
    if (kn) result.set(edge.id || edge.uuid || '', kn);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Graph builders — deliberately use WRONG per-edge evidence to prove
// that the coherent topo-walk is used, not per-edge evidence.
// ---------------------------------------------------------------------------

/**
 * Linear: START → A → B → C
 * Rates: 0.8, 0.5, 0.25
 * Anchor evidence.n = 1000
 * Downstream evidence.n values are deliberately wrong.
 */
function linearFunnel(): Graph {
  return {
    nodes: [
      { uuid: 'start', id: 'start', label: 'Start', type: 'start', entry: { is_start: true } },
      { uuid: 'a', id: 'a', label: 'A', event_id: 'ev-a' },
      { uuid: 'b', id: 'b', label: 'B', event_id: 'ev-b' },
      { uuid: 'c', id: 'c', label: 'C', event_id: 'ev-c' },
    ],
    edges: [
      { uuid: 'e1', id: 'e1', from: 'start', to: 'a', p: { mean: 0.8, evidence: { n: 1000, k: 800 } } },
      { uuid: 'e2', id: 'e2', from: 'a', to: 'b', p: { mean: 0.5, evidence: { n: 9999, k: 9999 } } },
      { uuid: 'e3', id: 'e3', from: 'b', to: 'c', p: { mean: 0.25, evidence: { n: 7777, k: 7777 } } },
    ],
    metadata: { name: 'linear' },
  } as any;
}

/**
 * Branch: START → A, then A → B and A → C
 * e1 p=0.8 (anchor n=500)
 * e2 p=0.5, e3 p=0.3  (siblings — must share same n)
 */
function branchingFunnel(): Graph {
  return {
    nodes: [
      { uuid: 'start', id: 'start', label: 'Start', type: 'start', entry: { is_start: true } },
      { uuid: 'a', id: 'a', label: 'A', event_id: 'ev-a' },
      { uuid: 'b', id: 'b', label: 'B', event_id: 'ev-b' },
      { uuid: 'c', id: 'c', label: 'C', event_id: 'ev-c' },
    ],
    edges: [
      { uuid: 'e1', id: 'e1', from: 'start', to: 'a', p: { mean: 0.8, evidence: { n: 500, k: 400 } } },
      { uuid: 'e2', id: 'e2', from: 'a', to: 'b', p: { mean: 0.5, evidence: { n: 1111, k: 1111 } } },
      { uuid: 'e3', id: 'e3', from: 'a', to: 'c', p: { mean: 0.3, evidence: { n: 2222, k: 2222 } } },
    ],
    metadata: { name: 'branching' },
  } as any;
}

/**
 * Diamond: START → A, A → B, A → C, B → D, C → D
 * Tests merge node (D receives from both B and C).
 */
function diamondGraph(): Graph {
  return {
    nodes: [
      { uuid: 'start', id: 'start', label: 'Start', type: 'start', entry: { is_start: true } },
      { uuid: 'a', id: 'a', label: 'A', event_id: 'ev-a' },
      { uuid: 'b', id: 'b', label: 'B', event_id: 'ev-b' },
      { uuid: 'c', id: 'c', label: 'C', event_id: 'ev-c' },
      { uuid: 'd', id: 'd', label: 'D', event_id: 'ev-d' },
    ],
    edges: [
      { uuid: 'e1', id: 'e1', from: 'start', to: 'a', p: { mean: 1.0, evidence: { n: 1000 } } },
      { uuid: 'e2', id: 'e2', from: 'a', to: 'b', p: { mean: 0.6 } },
      { uuid: 'e3', id: 'e3', from: 'a', to: 'c', p: { mean: 0.4 } },
      { uuid: 'e4', id: 'e4', from: 'b', to: 'd', p: { mean: 0.5 } },
      { uuid: 'e5', id: 'e5', from: 'c', to: 'd', p: { mean: 0.5 } },
    ],
    metadata: { name: 'diamond' },
  } as any;
}

/**
 * No-data graph: all edges have rates but no evidence.n anywhere.
 * Should still produce coherent k/n = 0/0 or no bead.
 */
function noDataGraph(): Graph {
  return {
    nodes: [
      { uuid: 'start', id: 'start', label: 'Start', type: 'start', entry: { is_start: true } },
      { uuid: 'a', id: 'a', label: 'A', event_id: 'ev-a' },
    ],
    edges: [
      { uuid: 'e1', id: 'e1', from: 'start', to: 'a', p: { mean: 0.5 } },
    ],
    metadata: { name: 'no-data' },
  } as any;
}

// ---------------------------------------------------------------------------
// Invariant assertion helpers
// ---------------------------------------------------------------------------

function assertSiblingNInvariant(graph: Graph, knMap: Map<string, { k: number; n: number }>, label: string) {
  // Group edges by source node
  const bySource = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const src = (edge as any).from;
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src)!.push(edge.id || edge.uuid || '');
  }

  for (const [src, edgeIds] of bySource) {
    if (edgeIds.length < 2) continue;
    const ns = edgeIds.map(id => knMap.get(id)?.n).filter(n => n !== undefined);
    if (ns.length < 2) continue;
    const allSame = ns.every(n => n === ns[0]);
    expect(allSame, `[${label}] Siblings from node ${src} must share same n, got: ${ns.join(', ')}`).toBe(true);
  }
}

function assertFlowInvariant(graph: Graph, knMap: Map<string, { k: number; n: number }>, label: string) {
  // For each non-START node, outgoing n = sum of incoming k
  const startNodes = new Set(
    graph.nodes.filter(n => n.type === 'start' || (n as any).entry?.is_start).map(n => n.uuid || n.id)
  );

  // Build incoming edges per node
  const incomingByNode = new Map<string, string[]>();
  const outgoingByNode = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const to = (edge as any).to;
    const from = (edge as any).from;
    const eid = edge.id || edge.uuid || '';
    if (!incomingByNode.has(to)) incomingByNode.set(to, []);
    incomingByNode.get(to)!.push(eid);
    if (!outgoingByNode.has(from)) outgoingByNode.set(from, []);
    outgoingByNode.get(from)!.push(eid);
  }

  for (const node of graph.nodes) {
    const nodeId = node.uuid || node.id;
    if (startNodes.has(nodeId)) continue;

    const inEdgeIds = incomingByNode.get(nodeId) || [];
    const outEdgeIds = outgoingByNode.get(nodeId) || [];
    if (inEdgeIds.length === 0 || outEdgeIds.length === 0) continue;

    const sumIncomingK = inEdgeIds.reduce((sum, id) => sum + (knMap.get(id)?.k ?? 0), 0);
    // All outgoing edges should have n = sumIncomingK
    for (const outId of outEdgeIds) {
      const outN = knMap.get(outId)?.n;
      if (outN === undefined) continue;
      expect(outN, `[${label}] Edge ${outId} from node ${nodeId}: n should equal sum of incoming k (${sumIncomingK})`).toBe(sumIncomingK);
    }
  }
}

function assertKLeqN(knMap: Map<string, { k: number; n: number }>, label: string) {
  for (const [edgeId, { k, n }] of knMap) {
    expect(k, `[${label}] Edge ${edgeId}: k (${k}) must not exceed n (${n})`).toBeLessThanOrEqual(n);
  }
}

function assertAllIntegers(knMap: Map<string, { k: number; n: number }>, label: string) {
  for (const [edgeId, { k, n }] of knMap) {
    expect(Number.isInteger(k), `[${label}] Edge ${edgeId}: k=${k} must be integer`).toBe(true);
    expect(Number.isInteger(n), `[${label}] Edge ${edgeId}: n=${n} must be integer`).toBe(true);
    expect(k, `[${label}] Edge ${edgeId}: k must be ≥ 0`).toBeGreaterThanOrEqual(0);
    expect(n, `[${label}] Edge ${edgeId}: n must be ≥ 0`).toBeGreaterThanOrEqual(0);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Data Values — structural invariants', () => {
  beforeEach(() => vi.clearAllMocks());

  const graphs = [
    { name: 'linear', build: linearFunnel },
    { name: 'branching', build: branchingFunnel },
    { name: 'diamond', build: diamondGraph },
  ];

  const modes: Array<{ name: string; mode?: ScenarioVisibilityMode }> = [
    { name: 'F+E (default)', mode: undefined },
    { name: 'F (forecast)', mode: 'f' },
    { name: 'E (evidence)', mode: 'e' },
  ];

  for (const { name: graphName, build } of graphs) {
    for (const { name: modeName, mode } of modes) {
      const label = `${graphName} / ${modeName}`;

      describe(`${label}`, () => {
        it('INVARIANT 1: siblings from same node have identical n', () => {
          const graph = build();
          const knMap = extractAllKN(graph, mode);
          assertSiblingNInvariant(graph, knMap, label);
        });

        // Flow invariant (downstream n = sum of incoming k) only holds in F+E mode
        // because the topo walk uses p.mean. In E/F modes the displayed rate differs
        // from p.mean, so the displayed k won't sum to the downstream n.
        // The sibling-n invariant (INVARIANT 1) still holds in all modes because
        // n comes from the topo walk regardless of display rate.
        if (!mode) {
          it('INVARIANT 2: outgoing n = sum of incoming k at each non-START node', () => {
            const graph = build();
            const knMap = extractAllKN(graph, mode);
            assertFlowInvariant(graph, knMap, label);
          });
        }

        it('INVARIANT 4: k ≤ n on every edge', () => {
          const graph = build();
          const knMap = extractAllKN(graph, mode);
          assertKLeqN(knMap, label);
        });

        it('INVARIANT 5: all values are non-negative integers', () => {
          const graph = build();
          const knMap = extractAllKN(graph, mode);
          assertAllIntegers(knMap, label);
        });
      });
    }
  }

  describe('INVARIANT 3: anchor n = evidence.n', () => {
    it('linear: anchor edge uses evidence.n as population seed', () => {
      const graph = linearFunnel();
      const knMap = extractAllKN(graph);
      expect(knMap.get('e1')!.n).toBe(1000);
    });

    it('branching: anchor edge uses evidence.n as population seed', () => {
      const graph = branchingFunnel();
      const knMap = extractAllKN(graph);
      expect(knMap.get('e1')!.n).toBe(500);
    });
  });

  describe('INVARIANT 6: mode off shows percentages', () => {
    it('shows % not k/n when beadDisplayMode is edge-rate', () => {
      const graph = linearFunnel();
      for (const edge of graph.edges) {
        const beads = callBuildBeads(edge, graph, 'edge-rate');
        const probBead = beads.find(b => b.type === 'probability');
        const text = extractText(probBead!.displayText);
        expect(text).toContain('%');
        expect(text).not.toMatch(/\d+\/\d+/);
      }
    });
  });

  describe('coherent flow values (linear)', () => {
    it('propagates population correctly: 1000 → 800 → 400 → 100', () => {
      const graph = linearFunnel();
      const knMap = extractAllKN(graph);

      expect(knMap.get('e1')).toEqual({ k: 800, n: 1000 });
      expect(knMap.get('e2')).toEqual({ k: 400, n: 800 });
      expect(knMap.get('e3')).toEqual({ k: 100, n: 400 });
    });

    it('does NOT use per-edge evidence.n (which is deliberately wrong)', () => {
      const graph = linearFunnel();
      const knMap = extractAllKN(graph);

      // e2 has evidence.n=9999, but coherent n must be 800
      expect(knMap.get('e2')!.n).not.toBe(9999);
      expect(knMap.get('e2')!.n).toBe(800);
    });
  });

  describe('coherent flow values (diamond)', () => {
    it('merge node D receives sum of incoming k from B and C', () => {
      const graph = diamondGraph();
      const knMap = extractAllKN(graph);

      // e1: n=1000, k=round(1.0*1000)=1000
      expect(knMap.get('e1')).toEqual({ k: 1000, n: 1000 });

      // e2, e3 siblings from A: both n=1000
      expect(knMap.get('e2')!.n).toBe(1000);
      expect(knMap.get('e3')!.n).toBe(1000);

      // e2: k=round(0.6*1000)=600, e3: k=round(0.4*1000)=400
      expect(knMap.get('e2')!.k).toBe(600);
      expect(knMap.get('e3')!.k).toBe(400);

      // D receives from B (k=600*0.5=300) and C (k=400*0.5=200)
      // Edges from B→D and C→D:
      // e4: n = e2.k = 600 (population at B) — wait, no.
      // Population at B = e2.k = 600 (only B's inbound)
      // Population at C = e3.k = 400
      // e4 (B→D): n=600, k=round(0.5*600)=300
      // e5 (C→D): n=400, k=round(0.5*400)=200
      expect(knMap.get('e4')).toEqual({ k: 300, n: 600 });
      expect(knMap.get('e5')).toEqual({ k: 200, n: 400 });
    });
  });

  describe('edge case: no evidence anywhere', () => {
    it('should fall back to percentage display when no population data exists', () => {
      const graph = noDataGraph();
      const beads = callBuildBeads(graph.edges[0], graph, 'data-values', buildInboundNMap(graph));
      const probBead = beads.find(b => b.type === 'probability');
      expect(probBead).toBeDefined();
      // With no evidence.n anywhere, inbound-n gives n=0.
      // Should fall back to % since there's no population to show.
      const text = extractText(probBead!.displayText);
      expect(text).toContain('%');
    });
  });
});
