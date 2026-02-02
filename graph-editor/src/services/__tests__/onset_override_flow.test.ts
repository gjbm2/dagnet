/**
 * Onset Delta Days Override Flow Tests
 * 
 * Tests that user-set onset_delta_days values (marked with onset_delta_days_overridden: true)
 * are preserved through data fetch and LAG pass cycles.
 * 
 * DESIGN PRINCIPLE:
 * - When onset_delta_days_overridden is true, the computed onset from LAG pass
 *   should NOT overwrite the user's manual value.
 * - This allows users to override onset for edges where the histogram data
 *   doesn't accurately reflect the true onset delay.
 * 
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { UpdateManager } from '../UpdateManager';

describe('onset_delta_days Override Flow', () => {
  describe('applyBatchLAGValues respects overrides', () => {
    it('should NOT overwrite onset when onset_delta_days_overridden is true', () => {
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
            onset_delta_days: 3,  // Computed value - should be ignored due to override
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.latency.onset_delta_days).toBe(10); // User value preserved
      expect(e.p.latency.onset_delta_days_overridden).toBe(true);
    });

    it('should overwrite onset when onset_delta_days_overridden is false', () => {
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
            onset_delta_days: 3,
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.latency.onset_delta_days).toBe(3); // Computed value applied
    });

    it('should overwrite onset when onset_delta_days_overridden is undefined', () => {
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
            onset_delta_days: 3,
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.latency.onset_delta_days).toBe(3); // Computed value applied
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
            // onset_delta_days NOT provided
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.latency.onset_delta_days).toBe(10); // Preserved
      expect(e.p.latency.onset_delta_days_overridden).toBe(true); // Flag preserved
    });
  });

  describe('Conditional probability override flow', () => {
    it('should respect onset override for conditional_p[i].p.latency', () => {
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
            onset_delta_days: 5,  // Computed - should be ignored
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.conditional_p[0].p.latency.onset_delta_days).toBe(15); // User value preserved
      expect(e.conditional_p[0].p.latency.onset_delta_days_overridden).toBe(true);
    });

    it('should update conditional onset when not overridden', () => {
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
            onset_delta_days: 5,
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.conditional_p[0].p.latency.onset_delta_days).toBe(5); // Computed value applied
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
            onset_delta_days: 5,  // Computed non-zero - should be ignored
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.latency.onset_delta_days).toBe(0); // User's 0 preserved
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
            onset_delta_days: 5,
          },
        },
      ]);

      const e = next.edges.find((x: any) => x.id === 'A-B');
      expect(e.p.latency.onset_delta_days).toBe(5); // New value applied
    });
  });
});
