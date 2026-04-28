/**
 * Doc 73b §6.8 Action B8c (Stage 5) — lock-respecting writer discipline.
 *
 * Contract: `applyBatchLAGValues` must not overwrite `p.mean` or `p.stdev`
 * when their `*_overridden` flag is set. The discipline applies uniformly
 * to the unconditional `p` and to every entry under `conditional_p[X].p`.
 *
 * `p.stdev_pred` carries no `*_overridden` flag (row S6 — explicit non-add)
 * and is not user-overtypable; the lock check must NOT extend to it.
 *
 * This file pins the Stage 5 behavioural contract. Mismatch 5a fix: until
 * Stage 5 the `blendedMean` primary path wrote `p.mean` unconditionally
 * while the `evidence.mean` fallback already gated on `mean_overridden`.
 * The asymmetry is closed; both paths skip when locked.
 */
import { describe, it, expect } from 'vitest';
import { UpdateManager } from '../UpdateManager';

describe('UpdateManager.applyBatchLAGValues — lock-respecting writer discipline (Stage 5)', () => {
  describe('base edge p', () => {
    it('skips p.mean write from blendedMean when mean_overridden = true', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [{ id: 'A-B', from: 'A', to: 'B', p: { latency: {}, mean: 0.7, mean_overridden: true } }],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          latency: { t95: 10, completeness: 1, path_t95: 10 },
          blendedMean: 0.4,
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.mean).toBe(0.7); // locked value preserved
      expect(e.p.mean_overridden).toBe(true);
    });

    it('still writes p.mean from blendedMean when mean_overridden is unset / false', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [{ id: 'A-B', from: 'A', to: 'B', p: { latency: {}, mean: 0.7 } }],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          latency: { t95: 10, completeness: 1, path_t95: 10 },
          blendedMean: 0.4,
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.mean).toBe(0.4);
    });

    it('skips p.stdev write from update.stdev when stdev_overridden = true', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [{ id: 'A-B', from: 'A', to: 'B', p: { latency: {}, mean: 0.4, stdev: 0.05, stdev_overridden: true } }],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          latency: { t95: 10, completeness: 1, path_t95: 10 },
          stdev: 0.123,
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.stdev).toBe(0.05); // locked value preserved
      expect(e.p.stdev_overridden).toBe(true);
    });

    it('writes p.stdev_pred even when stdev_overridden = true (predictive flavour has no lock — row S6)', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [{ id: 'A-B', from: 'A', to: 'B', p: { latency: {}, mean: 0.4, stdev: 0.05, stdev_overridden: true } }],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          latency: { t95: 10, completeness: 1, path_t95: 10 },
          stdev: 0.123,       // gated by stdev_overridden — skipped
          stdev_pred: 0.456,  // not gated — applied
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.stdev).toBe(0.05);
      expect(e.p.stdev_pred).toBe(0.456);
    });

    it('does not push a locked edge onto edgesToRebalance (no rebalance trigger from skipped write)', () => {
      const um = new UpdateManager();
      // Two siblings out of A: A-B locked at 0.7, A-C free at 0.3.
      // applyBatchLAGValues tries to push A-B to 0.5 via blendedMean.
      // Locked A-B must not move; A-C must not be rebalanced as a consequence
      // of an attempted-but-skipped A-B write.
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
        edges: [
          { id: 'A-B', from: 'A', to: 'B', p: { latency: {}, mean: 0.7, mean_overridden: true } },
          { id: 'A-C', from: 'A', to: 'C', p: { latency: {}, mean: 0.3 } },
        ],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          latency: { t95: 10, completeness: 1, path_t95: 10 },
          blendedMean: 0.5,
        },
      ]);

      const ab = next.edges.find((x: any) => x.id === 'A-B');
      const ac = next.edges.find((x: any) => x.id === 'A-C');
      expect(ab.p.mean).toBe(0.7);
      expect(ac.p.mean).toBe(0.3);
    });
  });

  describe('conditional_p[i].p — same lock discipline applies uniformly', () => {
    it('skips conditional_p[0].p.mean write from blendedMean when conditional mean_overridden = true', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          {
            id: 'A-B',
            from: 'A',
            to: 'B',
            p: { latency: {}, mean: 0.5 },
            conditional_p: [
              { condition: 'visited(b)', p: { latency: {}, mean: 0.8, mean_overridden: true } },
            ],
          },
        ],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          conditionalIndex: 0,
          latency: { t95: 10, completeness: 1, path_t95: 10 },
          blendedMean: 0.4,
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.conditional_p[0].p.mean).toBe(0.8); // locked conditional preserved
      expect(e.conditional_p[0].p.mean_overridden).toBe(true);
      // Base p untouched by a conditional update.
      expect(e.p.mean).toBe(0.5);
    });

    it('still writes conditional_p[0].p.mean when its mean_overridden is unset', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          {
            id: 'A-B',
            from: 'A',
            to: 'B',
            p: { latency: {}, mean: 0.5 },
            conditional_p: [
              { condition: 'visited(b)', p: { latency: {}, mean: 0.8 } },
            ],
          },
        ],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          conditionalIndex: 0,
          latency: { t95: 10, completeness: 1, path_t95: 10 },
          blendedMean: 0.4,
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.conditional_p[0].p.mean).toBe(0.4);
    });

    it('skips conditional_p[0].p.stdev write when conditional stdev_overridden = true', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          {
            id: 'A-B',
            from: 'A',
            to: 'B',
            p: { latency: {}, mean: 0.5, stdev: 0.05 },
            conditional_p: [
              { condition: 'visited(b)', p: { latency: {}, mean: 0.8, stdev: 0.01, stdev_overridden: true } },
            ],
          },
        ],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          conditionalIndex: 0,
          latency: { t95: 10, completeness: 1, path_t95: 10 },
          stdev: 0.123,
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.conditional_p[0].p.stdev).toBe(0.01); // locked conditional preserved
      expect(e.conditional_p[0].p.stdev_overridden).toBe(true);
      // Base stdev untouched by a conditional update.
      expect(e.p.stdev).toBe(0.05);
    });

    it('writes conditional_p[0].p.stdev_pred even when conditional stdev_overridden = true', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          {
            id: 'A-B',
            from: 'A',
            to: 'B',
            p: { latency: {}, mean: 0.5, stdev: 0.05 },
            conditional_p: [
              { condition: 'visited(b)', p: { latency: {}, mean: 0.8, stdev: 0.01, stdev_overridden: true } },
            ],
          },
        ],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          conditionalIndex: 0,
          latency: { t95: 10, completeness: 1, path_t95: 10 },
          stdev: 0.123,       // gated — skipped
          stdev_pred: 0.456,  // not gated — applied
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.conditional_p[0].p.stdev).toBe(0.01);
      expect(e.conditional_p[0].p.stdev_pred).toBe(0.456);
    });
  });
});
