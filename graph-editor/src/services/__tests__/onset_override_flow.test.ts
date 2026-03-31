/**
 * Onset Delta Days Override Flow Tests
 *
 * Tests that user-set onset_delta_days values (marked with onset_delta_days_overridden: true)
 * are preserved through data fetch and LAG pass cycles.
 *
 * DESIGN PRINCIPLE (promoted pattern):
 * - The LAG/stats pass writes to promoted_onset_delta_days (model output)
 * - The user's onset_delta_days (model input) is never overwritten by the pass
 * - onset_delta_days_overridden controls whether the input or promoted value
 *   feeds into the next model run (handled by modelVarsResolution, not here)
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { UpdateManager } from '../UpdateManager';

describe('onset_delta_days Override Flow', () => {
  describe('applyBatchLAGValues writes promoted field', () => {
    it('should NOT overwrite onset_delta_days when override is true, but should write promoted', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          {
            id: 'A-B',
            from: 'A',
            to: 'B',
            p: {
              latency: {
                onset_delta_days: 10,                    // User-set value
                onset_delta_days_overridden: true,       // User override flag
              },
            },
          },
        ],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          latency: {
            t95: 30,
            completeness: 0.9,
            path_t95: 30,
            promoted_onset_delta_days: 3,
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.latency.onset_delta_days).toBe(10); // User value preserved
      expect(e.p.latency.onset_delta_days_overridden).toBe(true);
      expect(e.p.latency.promoted_onset_delta_days).toBe(3); // Promoted always written
    });

    it('should write promoted_onset_delta_days when override is false', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          {
            id: 'A-B',
            from: 'A',
            to: 'B',
            p: {
              latency: {
                onset_delta_days: 10,
                onset_delta_days_overridden: false,
              },
            },
          },
        ],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          latency: {
            t95: 30,
            completeness: 0.9,
            path_t95: 30,
            promoted_onset_delta_days: 3,
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.latency.onset_delta_days).toBe(10); // Input untouched
      expect(e.p.latency.promoted_onset_delta_days).toBe(3); // Promoted written
    });

    it('should write promoted_onset_delta_days when override is undefined', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          {
            id: 'A-B',
            from: 'A',
            to: 'B',
            p: {
              latency: {
                onset_delta_days: 10,
                // onset_delta_days_overridden is NOT set
              },
            },
          },
        ],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          latency: {
            t95: 30,
            completeness: 0.9,
            path_t95: 30,
            promoted_onset_delta_days: 3,
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.latency.onset_delta_days).toBe(10); // Input untouched
      expect(e.p.latency.promoted_onset_delta_days).toBe(3); // Promoted written
    });
  });

  describe('Override flag persistence across updates', () => {
    it('should preserve override flag when onset is not in update', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          {
            id: 'A-B',
            from: 'A',
            to: 'B',
            p: {
              latency: {
                onset_delta_days: 10,
                onset_delta_days_overridden: true,
              },
            },
          },
        ],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          latency: {
            t95: 30,
            completeness: 0.9,
            path_t95: 30,
            // promoted_onset_delta_days NOT provided
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.latency.onset_delta_days).toBe(10); // Preserved
      expect(e.p.latency.onset_delta_days_overridden).toBe(true); // Flag preserved
    });
  });

  describe('Conditional probability override flow', () => {
    it('should preserve conditional onset when overridden, but write promoted', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          {
            id: 'A-B',
            from: 'A',
            to: 'B',
            p: { latency: {} },
            conditional_p: [
              {
                condition: 'context(channel:paid)',
                p: {
                  latency: {
                    onset_delta_days: 15,
                    onset_delta_days_overridden: true,
                  },
                },
              },
            ],
          },
        ],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          conditionalIndex: 0,
          latency: {
            t95: 30,
            completeness: 0.9,
            path_t95: 30,
            promoted_onset_delta_days: 5,
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.conditional_p[0].p.latency.onset_delta_days).toBe(15); // User value preserved
      expect(e.conditional_p[0].p.latency.onset_delta_days_overridden).toBe(true);
      expect(e.conditional_p[0].p.latency.promoted_onset_delta_days).toBe(5); // Promoted written
    });

    it('should write promoted for conditional onset when not overridden', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          {
            id: 'A-B',
            from: 'A',
            to: 'B',
            p: { latency: {} },
            conditional_p: [
              {
                condition: 'context(channel:paid)',
                p: {
                  latency: {
                    onset_delta_days: 15,
                    onset_delta_days_overridden: false,
                  },
                },
              },
            ],
          },
        ],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          conditionalIndex: 0,
          latency: {
            t95: 30,
            completeness: 0.9,
            path_t95: 30,
            promoted_onset_delta_days: 5,
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.conditional_p[0].p.latency.onset_delta_days).toBe(15); // Input untouched
      expect(e.conditional_p[0].p.latency.promoted_onset_delta_days).toBe(5); // Promoted written
    });
  });

  describe('Edge cases', () => {
    it('should handle onset_delta_days = 0 with override', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          {
            id: 'A-B',
            from: 'A',
            to: 'B',
            p: {
              latency: {
                onset_delta_days: 0,                     // User sets to 0 (immediate)
                onset_delta_days_overridden: true,
              },
            },
          },
        ],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          latency: {
            t95: 30,
            completeness: 0.9,
            path_t95: 30,
            promoted_onset_delta_days: 5,
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.latency.onset_delta_days).toBe(0); // User's 0 preserved
      expect(e.p.latency.promoted_onset_delta_days).toBe(5); // Promoted still written
    });

    it('should handle newly computed onset when no prior value exists', () => {
      const um = new UpdateManager();
      const graph: any = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          {
            id: 'A-B',
            from: 'A',
            to: 'B',
            p: {
              latency: {},  // No onset_delta_days yet
            },
          },
        ],
        metadata: {},
      };

      const next = um.applyBatchLAGValues(graph, [
        {
          edgeId: 'A-B',
          latency: {
            t95: 30,
            completeness: 0.9,
            path_t95: 30,
            promoted_onset_delta_days: 5,
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.latency.promoted_onset_delta_days).toBe(5); // Promoted written
    });
  });
});
