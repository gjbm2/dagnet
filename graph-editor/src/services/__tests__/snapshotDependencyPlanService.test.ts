/**
 * snapshotDependencyPlanService tests
 *
 * Tests the thin mapper: FetchPlan → SnapshotSubjectRequest[].
 *
 * The mapper does NOT do fetch planning. It takes a FetchPlan (built by the
 * existing planner) and maps it to the wire format the backend needs for
 * snapshot-based analysis.
 *
 * Graph traversal helpers (funnel_path, reachable_from) are also tested here.
 */
import { describe, it, expect } from 'vitest';

import {
  mapFetchPlanToSnapshotSubjects,
  resolveFunnelPathEdges,
  resolveReachableEdges,
  type SnapshotSubjectRequest,
} from '../snapshotDependencyPlanService';
import type { FetchPlan, FetchPlanItem } from '../fetchPlanTypes';
import { computeShortCoreHash } from '../coreHashService';

// ============================================================
// Helpers
// ============================================================

const WORKSPACE = { repository: 'myrepo', branch: 'main' };

/** A valid query signature string */
const VALID_SIG = '{"c":"abc123","x":{}}';

/** Build a minimal FetchPlan with the given items */
function makePlan(items: Partial<FetchPlanItem>[]): FetchPlan {
  return {
    version: 1,
    createdAt: '2025-12-01T00:00:00Z',
    referenceNow: '2025-12-01T00:00:00Z',
    dsl: 'window(1-Nov-25:30-Nov-25)',
    items: items.map(item => ({
      itemKey: item.itemKey ?? `parameter:${item.objectId ?? 'p1'}:${item.targetId ?? 'e1'}:${item.slot ?? ''}:${item.conditionalIndex ?? ''}`,
      type: item.type ?? 'parameter',
      objectId: item.objectId ?? 'p1',
      targetId: item.targetId ?? 'e1',
      slot: item.slot,
      conditionalIndex: item.conditionalIndex,
      mode: item.mode ?? 'window',
      sliceFamily: item.sliceFamily ?? '',
      querySignature: item.querySignature ?? VALID_SIG,
      classification: item.classification ?? 'covered',
      windows: item.windows ?? [],
    })) as FetchPlanItem[],
  };
}

/** Minimal graph for scope rule tests */
function makeGraph(edges: Array<{ uuid: string; from: string; to: string }>) {
  return {
    nodes: [
      { id: 'A', uuid: 'node-a' },
      { id: 'B', uuid: 'node-b' },
      { id: 'C', uuid: 'node-c' },
    ],
    edges: edges.map(e => ({
      uuid: e.uuid,
      from: e.from,
      to: e.to,
      p: { id: `param-${e.uuid}` },
    })),
  } as any;
}

// ============================================================
// Tests
// ============================================================

describe('snapshotDependencyPlanService', () => {

  // ─────────────────────────────────────────────────────────
  // Contract lookup
  // ─────────────────────────────────────────────────────────

  describe('contract lookup', () => {
    it('returns undefined for analysis types without snapshotContract', async () => {
      const plan = makePlan([{ targetId: 'e1' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'graph_overview',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      expect(result).toBeUndefined();
    });

    it('returns ResolverResult for lag_histogram', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      expect(result).toBeDefined();
      expect(result!.subjects.length).toBe(1);
    });

    it('returns ResolverResult for daily_conversions', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'daily_conversions',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      expect(result).toBeDefined();
      expect(result!.subjects.length).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Scope rules (filtering plan items)
  // ─────────────────────────────────────────────────────────

  describe('scope rules', () => {
    it('selection_edge: only includes matching edge', async () => {
      const plan = makePlan([
        { targetId: 'e1', objectId: 'p1' },
        { targetId: 'e2', objectId: 'p2' },
      ]);
      const graph = makeGraph([
        { uuid: 'e1', from: 'A', to: 'B' },
        { uuid: 'e2', from: 'B', to: 'C' },
      ]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      expect(result!.subjects.length).toBe(1);
      expect(result!.subjects[0].target.targetId).toBe('e1');
    });

    it('selection_edge: no subjects if no edge selected', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: [],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      expect(result!.subjects.length).toBe(0);
    });

    it('multiple selected edges: includes all', async () => {
      const plan = makePlan([
        { targetId: 'e1', objectId: 'p1' },
        { targetId: 'e2', objectId: 'p2' },
      ]);
      const graph = makeGraph([
        { uuid: 'e1', from: 'A', to: 'B' },
        { uuid: 'e2', from: 'B', to: 'C' },
      ]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1', 'e2'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      expect(result!.subjects.length).toBe(2);
      const targetIds = result!.subjects.map(s => s.target.targetId).sort();
      expect(targetIds).toEqual(['e1', 'e2']);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Graph traversal scope rules (funnel_path, reachable_from)
  // ─────────────────────────────────────────────────────────

  describe('funnel_path scope rule', () => {
    function makeFunnelGraph() {
      return {
        nodes: [
          { id: 'A', uuid: 'nA' },
          { id: 'B', uuid: 'nB' },
          { id: 'C', uuid: 'nC' },
          { id: 'D', uuid: 'nD' },
          { id: 'E', uuid: 'nE' },
          { id: 'F', uuid: 'nF' },
          { id: 'G', uuid: 'nG' },
        ],
        edges: [
          { uuid: 'e1', from: 'nA', to: 'nB', p: { id: 'p1' } },
          { uuid: 'e2', from: 'nB', to: 'nC', p: { id: 'p2' } },
          { uuid: 'e3', from: 'nC', to: 'nD', p: { id: 'p3' } },
          { uuid: 'e4', from: 'nC', to: 'nE', p: { id: 'p4' } },
          { uuid: 'e5', from: 'nF', to: 'nG', p: { id: 'p5' } },
        ],
      } as any;
    }

    it('finds all edges on path from A to D', () => {
      const edgeUuids = resolveFunnelPathEdges(makeFunnelGraph(), 'from(A).to(D)');
      expect(edgeUuids).toEqual(new Set(['e1', 'e2', 'e3']));
    });

    it('includes branch edges when they lead to target', () => {
      const edgeUuids = resolveFunnelPathEdges(makeFunnelGraph(), 'from(A).to(E)');
      expect(edgeUuids).toEqual(new Set(['e1', 'e2', 'e4']));
    });

    it('returns empty set when from/to not connected', () => {
      expect(resolveFunnelPathEdges(makeFunnelGraph(), 'from(A).to(G)').size).toBe(0);
    });

    it('returns empty set when DSL has no from/to', () => {
      expect(resolveFunnelPathEdges(makeFunnelGraph(), 'window(1-Nov-25:30-Nov-25)').size).toBe(0);
    });

    it('handles diamond graph correctly', () => {
      const graph = {
        nodes: [
          { id: 'A', uuid: 'nA' },
          { id: 'B', uuid: 'nB' },
          { id: 'C', uuid: 'nC' },
          { id: 'D', uuid: 'nD' },
        ],
        edges: [
          { uuid: 'e1', from: 'nA', to: 'nB', p: { id: 'p1' } },
          { uuid: 'e2', from: 'nB', to: 'nD', p: { id: 'p2' } },
          { uuid: 'e3', from: 'nA', to: 'nC', p: { id: 'p3' } },
          { uuid: 'e4', from: 'nC', to: 'nD', p: { id: 'p4' } },
        ],
      } as any;
      expect(resolveFunnelPathEdges(graph, 'from(A).to(D)')).toEqual(new Set(['e1', 'e2', 'e3', 'e4']));
    });
  });

  describe('reachable_from scope rule', () => {
    function makeReachableGraph() {
      return {
        nodes: [
          { id: 'A', uuid: 'nA' },
          { id: 'B', uuid: 'nB' },
          { id: 'C', uuid: 'nC' },
          { id: 'D', uuid: 'nD' },
          { id: 'E', uuid: 'nE' },
          { id: 'F', uuid: 'nF' },
          { id: 'G', uuid: 'nG' },
        ],
        edges: [
          { uuid: 'e1', from: 'nA', to: 'nB', p: { id: 'p1' } },
          { uuid: 'e2', from: 'nB', to: 'nC', p: { id: 'p2' } },
          { uuid: 'e3', from: 'nC', to: 'nD', p: { id: 'p3' } },
          { uuid: 'e4', from: 'nC', to: 'nE', p: { id: 'p4' } },
          { uuid: 'e5', from: 'nF', to: 'nG', p: { id: 'p5' } },
        ],
      } as any;
    }

    it('finds all downstream edges from selected edge start node', () => {
      expect(resolveReachableEdges(makeReachableGraph(), ['e1']))
        .toEqual(new Set(['e1', 'e2', 'e3', 'e4']));
    });

    it('finds only downstream edges from a midpoint', () => {
      expect(resolveReachableEdges(makeReachableGraph(), ['e2']))
        .toEqual(new Set(['e2', 'e3', 'e4']));
    });

    it('does not include disconnected edges', () => {
      expect(resolveReachableEdges(makeReachableGraph(), ['e1']).has('e5')).toBe(false);
    });

    it('returns empty set for empty selection', () => {
      expect(resolveReachableEdges(makeReachableGraph(), []).size).toBe(0);
    });

    it('handles multiple start edges', () => {
      expect(resolveReachableEdges(makeReachableGraph(), ['e1', 'e5']))
        .toEqual(new Set(['e1', 'e2', 'e3', 'e4', 'e5']));
    });
  });

  // ─────────────────────────────────────────────────────────
  // Time bounds derivation
  // ─────────────────────────────────────────────────────────

  describe('time bounds', () => {
    it('derives anchor_from/to from window() clause', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      const subject = result!.subjects[0];
      expect(subject.anchor_from).toBe('2025-11-01');
      expect(subject.anchor_to).toBe('2025-11-30');
    });

    it('derives anchor_from/to from cohort() clause', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'cohort(1-Oct-25:31-Oct-25)',
      });

      const subject = result!.subjects[0];
      expect(subject.anchor_from).toBe('2025-10-01');
      expect(subject.anchor_to).toBe('2025-10-31');
    });

    it('returns empty subjects when DSL has no window/cohort', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'from(A).to(B)',
      });

      expect(result!.subjects.length).toBe(0);
      expect(result!.skipped.length).toBe(1);
      expect(result!.skipped[0].reason).toContain('time bounds');
    });
  });

  // ─────────────────────────────────────────────────────────
  // Identity / field mapping
  // ─────────────────────────────────────────────────────────

  describe('identity mapping', () => {
    it('builds workspace-prefixed param_id from plan item objectId', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'my-param' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: { repository: 'owner/repo', branch: 'develop' },
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      expect(result!.subjects[0].param_id).toBe('owner/repo-develop-my-param');
    });

    it('computes core_hash from plan item querySignature', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1', querySignature: VALID_SIG }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      const subject = result!.subjects[0];
      expect(subject.core_hash).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(subject.canonical_signature).toBe(VALID_SIG);

      // Verify against direct computation
      const expectedHash = await computeShortCoreHash(VALID_SIG);
      expect(subject.core_hash).toBe(expectedHash);
    });

    it('read_mode comes from analysis type contract', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      expect(result!.subjects[0].read_mode).toBe('raw_snapshots');
    });

    it('slice_keys comes from plan item sliceFamily', async () => {
      const plan = makePlan([
        { targetId: 'e1', objectId: 'p1', sliceFamily: 'context(channel:google)' },
      ]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      expect(result!.subjects[0].slice_keys).toEqual(['context(channel:google).window()']);
    });

    it('empty sliceFamily produces uncontexted slice key', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1', sliceFamily: '' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      expect(result!.subjects[0].slice_keys).toEqual(['window()']);
    });

    it('target includes slot and conditionalIndex from plan item', async () => {
      const plan = makePlan([
        { targetId: 'e1', objectId: 'p1', slot: 'cost_gbp' as const, conditionalIndex: 2 },
      ]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      expect(result!.subjects[0].target.targetId).toBe('e1');
      expect(result!.subjects[0].target.slot).toBe('cost_gbp');
      expect(result!.subjects[0].target.conditionalIndex).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Skipped subjects
  // ─────────────────────────────────────────────────────────

  describe('skipped subjects', () => {
    it('skips plan items with empty querySignature', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1', querySignature: '' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      expect(result!.subjects.length).toBe(0);
      expect(result!.skipped.length).toBe(1);
      expect(result!.skipped[0].reason).toContain('signature');
    });

    it('produces both subjects and skipped when some items lack signatures', async () => {
      const plan = makePlan([
        { targetId: 'e1', objectId: 'p1', querySignature: VALID_SIG },
        { targetId: 'e2', objectId: 'p2', querySignature: '' },
      ]);
      const graph = makeGraph([
        { uuid: 'e1', from: 'A', to: 'B' },
        { uuid: 'e2', from: 'B', to: 'C' },
      ]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1', 'e2'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      expect(result!.subjects.length).toBe(1);
      expect(result!.subjects[0].target.targetId).toBe('e1');
      expect(result!.skipped.length).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────
  // subject_id stability
  // ─────────────────────────────────────────────────────────

  describe('subject_id', () => {
    it('uses plan item itemKey as subject_id (deterministic)', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const args = {
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      };

      const r1 = await mapFetchPlanToSnapshotSubjects(args);
      const r2 = await mapFetchPlanToSnapshotSubjects(args);

      expect(r1!.subjects[0].subject_id).toBe(r2!.subjects[0].subject_id);
      // subject_id should match the plan item's itemKey
      expect(r1!.subjects[0].subject_id).toBe(plan.items[0].itemKey);
    });
  });

  // ─────────────────────────────────────────────────────────
  // cohort_maturity contract
  // ─────────────────────────────────────────────────────────

  describe('cohort_maturity', () => {
    it('resolves with read_mode cohort_maturity and sweep bounds', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'cohort_maturity',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'cohort(1-Oct-25:31-Oct-25)',
      });

      expect(result).toBeDefined();
      expect(result!.subjects.length).toBe(1);

      const subject = result!.subjects[0];
      expect(subject.read_mode).toBe('cohort_maturity');
      expect(subject.anchor_from).toBe('2025-10-01');
      expect(subject.anchor_to).toBe('2025-10-31');
      expect(subject.sweep_from).toBe('2025-10-01');
      expect(subject.sweep_to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('sweep_to respects asat() date when present', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'cohort_maturity',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'cohort(1-Oct-25:31-Oct-25).asat(15-Dec-25)',
      });

      const subject = result!.subjects[0];
      expect(subject.sweep_to).toBe('2025-12-15');
      // as_at should also be set
      expect(subject.as_at).toContain('2025-12-15');
    });

    it('sweep_to defaults to today when no asat()', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'cohort_maturity',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'cohort(1-Oct-25:31-Oct-25)',
      });

      const subject = result!.subjects[0];
      const today = new Date().toISOString().split('T')[0];
      expect(subject.sweep_to).toBe(today);
      expect(subject.as_at).toBeUndefined();
    });

    it('window() also works as cohort range for cohort_maturity', async () => {
      const plan = makePlan([{ targetId: 'e1', objectId: 'p1' }]);
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'cohort_maturity',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      expect(result!.subjects.length).toBe(1);
      const subject = result!.subjects[0];
      expect(subject.read_mode).toBe('cohort_maturity');
      expect(subject.anchor_from).toBe('2025-11-01');
      expect(subject.anchor_to).toBe('2025-11-30');
      expect(subject.sweep_from).toBe('2025-11-01');
    });
  });

  // ─────────────────────────────────────────────────────────
  // Case items are filtered out
  // ─────────────────────────────────────────────────────────

  describe('filtering', () => {
    it('ignores case-type plan items (only parameters)', async () => {
      const plan: FetchPlan = {
        version: 1,
        createdAt: '2025-12-01T00:00:00Z',
        referenceNow: '2025-12-01T00:00:00Z',
        dsl: 'window(1-Nov-25:30-Nov-25)',
        items: [
          {
            itemKey: 'case:my-case:node-a::',
            type: 'case',
            objectId: 'my-case',
            targetId: 'node-a',
            mode: 'window',
            sliceFamily: '',
            querySignature: '',
            classification: 'covered',
            windows: [],
          },
          {
            itemKey: 'parameter:p1:e1:p:',
            type: 'parameter',
            objectId: 'p1',
            targetId: 'e1',
            slot: 'p',
            mode: 'window',
            sliceFamily: '',
            querySignature: VALID_SIG,
            classification: 'covered',
            windows: [],
          },
        ],
      };
      const graph = makeGraph([{ uuid: 'e1', from: 'A', to: 'B' }]);

      const result = await mapFetchPlanToSnapshotSubjects({
        plan,
        analysisType: 'lag_histogram',
        graph,
        selectedEdgeUuids: ['e1'],
        workspace: WORKSPACE,
        queryDsl: 'window(1-Nov-25:30-Nov-25)',
      });

      // Only the parameter item should be included
      expect(result!.subjects.length).toBe(1);
      expect(result!.subjects[0].target.targetId).toBe('e1');
    });
  });
});
