/**
 * Data Values View Mode Tests (blind, from spec)
 *
 * Spec invariants for "Data Values" mode:
 * 1. When evidence.k and evidence.n exist, bead shows those exact integers.
 * 2. When only rate + n exist, bead shows round(rate * n) / round(n).
 * 3. At each internal node of a funnel, sum of outgoing k values ≤ incoming n
 *    (conservation of population — k can't exceed the arriving population).
 * 4. Per-scenario: each scenario layer gets its own n/k derived from that
 *    layer's p object, not the base edge's.
 * 5. When data values mode is off, beads show percentages as normal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildBeadDefinitions } from '../edgeBeadHelpers';
import type { Graph, GraphEdge } from '../../../types';

// Mock the composition service to return scenario-specific params
const composedParamsStore = new Map<string, any>();
vi.mock('../../../services/CompositionService', () => ({
  getComposedParamsForLayer: vi.fn((layerId: string) => {
    return composedParamsStore.get(layerId) ?? { edges: {} };
  })
}));

vi.mock('@/lib/conditionalColours', () => ({
  getConditionalProbabilityColour: vi.fn(() => '#8B5CF6'),
  ensureDarkBeadColour: vi.fn((c: string) => c),
  darkenCaseColour: vi.fn((c: string) => c)
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse "k/n" string back to numbers */
function parseKN(displayText: any): { k: number; n: number } | null {
  // displayText is a React element tree; extract text content
  const text = extractText(displayText);
  const match = text.match(/(\d+)\/(\d+)/);
  if (!match) return null;
  return { k: parseInt(match[1], 10), n: parseInt(match[2], 10) };
}

/** Recursively extract text from React nodes */
function extractText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node.props?.children) return extractText(node.props.children);
  return '';
}

/**
 * Build a 3-step linear funnel: START → A → B → C
 *
 *   (start) --e1--> (A) --e2--> (B) --e3--> (C)
 *
 * evidence.n at anchor = 1000
 * e1: p=0.8, evidence n=1000 k=800
 * e2: p=0.5, evidence n=800  k=400
 * e3: p=0.25, evidence n=400 k=100
 */
function buildLinearFunnel(): { graph: Graph; edges: GraphEdge[] } {
  const nodes = [
    { uuid: 'start', id: 'start', label: 'Start', type: 'start', entry: { is_start: true } },
    { uuid: 'a', id: 'a', label: 'A', event_id: 'ev-a' },
    { uuid: 'b', id: 'b', label: 'B', event_id: 'ev-b' },
    { uuid: 'c', id: 'c', label: 'C', event_id: 'ev-c' },
  ];
  const edges: GraphEdge[] = [
    {
      uuid: 'e1', id: 'e1', from: 'start', to: 'a',
      p: { mean: 0.8, evidence: { n: 1000, k: 800 } },
    } as any,
    {
      uuid: 'e2', id: 'e2', from: 'a', to: 'b',
      p: { mean: 0.5, evidence: { n: 800, k: 400 } },
    } as any,
    {
      uuid: 'e3', id: 'e3', from: 'b', to: 'c',
      p: { mean: 0.25, evidence: { n: 400, k: 100 } },
    } as any,
  ];
  return {
    graph: { nodes, edges, metadata: { name: 'linear-funnel' } } as Graph,
    edges,
  };
}

/**
 * Build a branching funnel: START → A, then A → B and A → C
 *
 *          ┌──e2──> (B)
 * (start)──e1──>(A)─┤
 *          └──e3──> (C)
 *
 * e1: n=500 k=400 (p=0.8)
 * e2: n=400 k=200 (p=0.5)
 * e3: n=400 k=120 (p=0.3)
 * Invariant: e2.k + e3.k ≤ e1.k (= e2.n = e3.n)
 */
function buildBranchingFunnel(): { graph: Graph; edges: GraphEdge[] } {
  const nodes = [
    { uuid: 'start', id: 'start', label: 'Start', type: 'start', entry: { is_start: true } },
    { uuid: 'a', id: 'a', label: 'A', event_id: 'ev-a' },
    { uuid: 'b', id: 'b', label: 'B', event_id: 'ev-b' },
    { uuid: 'c', id: 'c', label: 'C', event_id: 'ev-c' },
  ];
  const edges: GraphEdge[] = [
    {
      uuid: 'e1', id: 'e1', from: 'start', to: 'a',
      p: { mean: 0.8, evidence: { n: 500, k: 400 } },
    } as any,
    {
      uuid: 'e2', id: 'e2', from: 'a', to: 'b',
      p: { mean: 0.5, evidence: { n: 400, k: 200 } },
    } as any,
    {
      uuid: 'e3', id: 'e3', from: 'a', to: 'c',
      p: { mean: 0.3, evidence: { n: 400, k: 120 } },
    } as any,
  ];
  return {
    graph: { nodes, edges, metadata: { name: 'branching-funnel' } } as Graph,
    edges,
  };
}

function baseScenariosContext() {
  return {
    scenarios: [],
    baseParams: { edges: {} },
    currentParams: { edges: {} },
  };
}

function callBuildBeads(
  edge: GraphEdge,
  graph: Graph,
  ctx: any,
  useDataValuesView: boolean
) {
  return buildBeadDefinitions(
    edge,
    graph,
    ctx,
    [],                             // scenarioOrder
    ['current'],                    // visibleScenarioIds
    ['current'],                    // visibleColourOrderIds
    new Map([['current', '#FFF']]), // scenarioColours
    undefined,                      // whatIfDSL
    0,                              // visibleStartOffset
    undefined,                      // getScenarioVisibilityMode
    useDataValuesView
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Data Values view mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    composedParamsStore.clear();
  });

  describe('invariant: exact evidence k/n shown when available', () => {
    it('should show evidence.k/evidence.n directly, not rate*n', () => {
      const { graph, edges } = buildLinearFunnel();
      const ctx = baseScenariosContext();

      for (const edge of edges) {
        const beads = callBuildBeads(edge, graph, ctx, true);
        const probBead = beads.find(b => b.type === 'probability');
        expect(probBead).toBeDefined();

        const kn = parseKN(probBead!.displayText);
        expect(kn).not.toBeNull();
        expect(kn!.k).toBe(edge.p!.evidence!.k);
        expect(kn!.n).toBe(edge.p!.evidence!.n);
      }
    });
  });

  describe('invariant: downstream n ≤ upstream k (population conservation)', () => {
    it('should conserve population through a linear funnel', () => {
      const { graph, edges } = buildLinearFunnel();
      const ctx = baseScenariosContext();

      const knByEdge = new Map<string, { k: number; n: number }>();
      for (const edge of edges) {
        const beads = callBuildBeads(edge, graph, ctx, true);
        const probBead = beads.find(b => b.type === 'probability');
        const kn = parseKN(probBead!.displayText);
        expect(kn).not.toBeNull();
        knByEdge.set(edge.uuid!, kn!);
      }

      // e2.n should equal e1.k (population arriving at node A = conversions from e1)
      expect(knByEdge.get('e2')!.n).toBe(knByEdge.get('e1')!.k);
      // e3.n should equal e2.k
      expect(knByEdge.get('e3')!.n).toBe(knByEdge.get('e2')!.k);
    });

    it('should conserve population through a branching funnel', () => {
      const { graph, edges } = buildBranchingFunnel();
      const ctx = baseScenariosContext();

      const knByEdge = new Map<string, { k: number; n: number }>();
      for (const edge of edges) {
        const beads = callBuildBeads(edge, graph, ctx, true);
        const probBead = beads.find(b => b.type === 'probability');
        const kn = parseKN(probBead!.displayText);
        expect(kn).not.toBeNull();
        knByEdge.set(edge.uuid!, kn!);
      }

      // Siblings e2 and e3 share the same n = e1.k (population arriving at node A)
      expect(knByEdge.get('e2')!.n).toBe(knByEdge.get('e1')!.k);
      expect(knByEdge.get('e3')!.n).toBe(knByEdge.get('e1')!.k);

      // Sum of outgoing k must not exceed the arriving population
      const sumK = knByEdge.get('e2')!.k + knByEdge.get('e3')!.k;
      expect(sumK).toBeLessThanOrEqual(knByEdge.get('e2')!.n);
    });
  });

  describe('invariant: per-scenario n/k uses layer-specific evidence', () => {
    it('should show different n/k for different scenarios', () => {
      // Edge with different evidence per scenario
      const edge: GraphEdge = {
        uuid: 'e1', id: 'e1', from: 'start', to: 'a',
        p: { mean: 0.5, evidence: { n: 1000, k: 500 } },
      } as any;
      const graph: Graph = {
        nodes: [
          { uuid: 'start', id: 'start', label: 'Start', type: 'start', entry: { is_start: true } },
          { uuid: 'a', id: 'a', label: 'A', event_id: 'ev-a' },
        ],
        edges: [edge],
        metadata: { name: 'scenario-test' },
      } as Graph;

      // Scenario "s1" has different evidence (n=2000, k=800)
      composedParamsStore.set('s1', {
        edges: {
          e1: { p: { mean: 0.4, evidence: { n: 2000, k: 800 } } },
        },
      });

      const ctx = {
        scenarios: [{ id: 's1', name: 'Scenario 1' }],
        baseParams: { edges: {} },
        currentParams: { edges: {} },
      };

      const beads = buildBeadDefinitions(
        edge,
        graph,
        ctx,
        [],                                    // scenarioOrder
        ['current', 's1'],                     // visibleScenarioIds
        ['current', 's1'],                     // visibleColourOrderIds
        new Map([['current', '#FFF'], ['s1', '#F00']]),
        undefined,                             // whatIfDSL
        0,                                     // visibleStartOffset
        undefined,                             // getScenarioVisibilityMode
        true                                   // useDataValuesView
      );

      const probBead = beads.find(b => b.type === 'probability');
      expect(probBead).toBeDefined();
      // With two visible scenarios showing different n/k, they should NOT be identical
      // (current: 500/1000, s1: 800/2000)
      expect(probBead!.allIdentical).toBe(false);

      // Check both values are present
      expect(probBead!.values).toHaveLength(2);
      const currentVal = probBead!.values.find((v: any) => v.scenarioId === 'current');
      const s1Val = probBead!.values.find((v: any) => v.scenarioId === 's1');
      expect(currentVal).toBeDefined();
      expect(s1Val).toBeDefined();
      expect(String(currentVal!.value)).toBe('500/1000');
      expect(String(s1Val!.value)).toBe('800/2000');
    });
  });

  describe('invariant: derived k when no evidence.k (forecast-only edge)', () => {
    it('should derive k = round(rate * n) when evidence.k is missing', () => {
      const edge: GraphEdge = {
        uuid: 'e1', id: 'e1', from: 'start', to: 'a',
        // Only n and mean, no k — simulates forecast population with no observed conversions
        p: { mean: 0.33, evidence: { n: 1000 } },
      } as any;
      const graph: Graph = {
        nodes: [
          { uuid: 'start', id: 'start', label: 'Start', type: 'start', entry: { is_start: true } },
          { uuid: 'a', id: 'a', label: 'A', event_id: 'ev-a' },
        ],
        edges: [edge],
        metadata: { name: 'derived-k-test' },
      } as Graph;

      const beads = callBuildBeads(edge, graph, baseScenariosContext(), true);
      const probBead = beads.find(b => b.type === 'probability');
      const kn = parseKN(probBead!.displayText);
      expect(kn).not.toBeNull();
      expect(kn!.n).toBe(1000);
      // 0.33 * 1000 = 330
      expect(kn!.k).toBe(330);
    });

    it('should use p.n (forecast population) when evidence.n is missing', () => {
      const edge: GraphEdge = {
        uuid: 'e1', id: 'e1', from: 'start', to: 'a',
        p: { mean: 0.6, n: 500 },  // p.n from topo walk, no evidence at all
      } as any;
      const graph: Graph = {
        nodes: [
          { uuid: 'start', id: 'start', label: 'Start', type: 'start', entry: { is_start: true } },
          { uuid: 'a', id: 'a', label: 'A', event_id: 'ev-a' },
        ],
        edges: [edge],
        metadata: { name: 'forecast-n-test' },
      } as Graph;

      const beads = callBuildBeads(edge, graph, baseScenariosContext(), true);
      const probBead = beads.find(b => b.type === 'probability');
      const kn = parseKN(probBead!.displayText);
      expect(kn).not.toBeNull();
      expect(kn!.n).toBe(500);
      expect(kn!.k).toBe(300); // 0.6 * 500
    });
  });

  describe('invariant: mode off shows percentages, not n/k', () => {
    it('should show percentage when useDataValuesView is false', () => {
      const { graph, edges } = buildLinearFunnel();
      const ctx = baseScenariosContext();

      const beads = callBuildBeads(edges[0], graph, ctx, false);
      const probBead = beads.find(b => b.type === 'probability');
      expect(probBead).toBeDefined();

      const text = extractText(probBead!.displayText);
      // Should contain a % sign, not a k/n slash
      expect(text).toContain('%');
      expect(text).not.toMatch(/\d+\/\d+/);
    });
  });

  describe('invariant: all displayed values are integers', () => {
    it('should round fractional n from forecast population', () => {
      const edge: GraphEdge = {
        uuid: 'e1', id: 'e1', from: 'start', to: 'a',
        p: { mean: 0.37, n: 333.7 },  // Fractional forecast population
      } as any;
      const graph: Graph = {
        nodes: [
          { uuid: 'start', id: 'start', label: 'Start', type: 'start', entry: { is_start: true } },
          { uuid: 'a', id: 'a', label: 'A', event_id: 'ev-a' },
        ],
        edges: [edge],
        metadata: { name: 'rounding-test' },
      } as Graph;

      const beads = callBuildBeads(edge, graph, baseScenariosContext(), true);
      const probBead = beads.find(b => b.type === 'probability');
      const kn = parseKN(probBead!.displayText);
      expect(kn).not.toBeNull();
      // n should be rounded to integer
      expect(kn!.n).toBe(334);
      // k = round(0.37 * 333.7) = round(123.469) = 123
      expect(kn!.k).toBe(123);
      // Both must be integers
      expect(Number.isInteger(kn!.k)).toBe(true);
      expect(Number.isInteger(kn!.n)).toBe(true);
    });
  });
});
