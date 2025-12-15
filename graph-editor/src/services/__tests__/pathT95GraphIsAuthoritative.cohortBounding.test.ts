/**
 * path_t95 – Graph is authoritative for cohort bounding
 *
 * From first principles (see docs/current/project-lag/t95-fix.md):
 * - `path_t95` is a persisted horizon primitive used to bound cohort() retrieval windows.
 * - Consumers must use the value on the graph/parameter view when present.
 * - Override flags only gate whether the system may overwrite the stored value; they do not create
 *   a second "effective" horizon for consumers.
 *
 * These tests assert that cohort horizon bounding prefers graph.path_t95 over any on-demand
 * estimation from cached cohort arrays.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dataOperationsService } from '../dataOperationsService';
import type { Graph } from '../../types';

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// Minimal fileRegistry mock (must be the same module path as production imports)
vi.mock('../../contexts/TabContext', () => {
  const mockFiles = new Map<string, any>();
  return {
    fileRegistry: {
      getFile: vi.fn((id: string) => mockFiles.get(id)),
      updateFile: vi.fn(async () => {}),
      registerFile: vi.fn(async (id: string, data: any) => {
        mockFiles.set(id, { data: structuredClone(data) });
      }),
      _mockFiles: mockFiles,
    },
  };
});

const { fileRegistry } = await import('../../contexts/TabContext');

describe('cohort() bounding uses persisted path_t95 (file for versioned, else graph)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any)._mockFiles.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-12-15T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prefers parameter file latency.path_t95 when present (even if graph differs and moment-matched estimate is available)', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g-path-t95',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'household-created', layout: { x: 0, y: 0 } } as any,
        { id: 'X', uuid: 'X', label: 'X', event_id: 'switch-registered', layout: { x: 0, y: 0 } } as any,
        { id: 'Y', uuid: 'Y', label: 'Y', event_id: 'switch-success', layout: { x: 0, y: 0 } } as any,
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'X',
          to: 'Y',
          p: {
            id: 'p1',
            connection: 'amplitude-prod',
            latency: {
              latency_parameter: true,
              anchor_node_id: 'A',
              t95: 13.12,
              // Graph may be stale mid-fetch; versioned planning should prefer the file's persisted latency config.
              path_t95: 26,
            },
          },
          query: 'from(switch-registered).to(switch-success)',
        } as any,
      ],
    };

    // Parameter file contains persisted latency config (source-of-truth for versioned fetch planning).
    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-prod',
      latency: {
        latency_parameter: true,
        anchor_node_id: 'A',
        t95: 13.12,
        path_t95: 40,
      },
      values: [
        {
          sliceDSL: 'cohort(household-created,10-Oct-25:12-Dec-25)',
          dates: ['10-Oct-25', '12-Dec-25'],
          n_daily: [1000, 1000],
          k_daily: [600, 600],
          // Local edge lag stats (X→Y)
          median_lag_days: [6.4, 6.4],
          mean_lag_days: [6.8, 6.8],
          // Anchor lag arrays (A→X), only present for downstream edges
          anchor_n_daily: [1500, 1500],
          anchor_median_lag_days: [10.25, 10.25],
          anchor_mean_lag_days: [10.51, 10.51],
          mean: 0.6,
          n: 2000,
          k: 1200,
          cohort_from: '10-Oct-25',
          cohort_to: '12-Dec-25',
          data_source: { retrieved_at: '2025-12-12T00:48:21.032Z', type: 'amplitude' },
        },
      ],
    });

    const report = await dataOperationsService.simulateRetrieveAllSlicesToMarkdown({
      graph,
      slices: ['cohort(-60d:)'],
      bustCache: false,
    });

    // Prove the moment-matched estimate was available (so this test would have caught the regression).
    expect(report).toContain('anchor+edge estimate (moment-matched):');
    expect(report).toContain('estimated path_t95(A→Y):');

    // Canonical requirement: versioned planning uses the persisted parameter file value.
    expect(report).toContain('effective path_t95 used for bounding: 40.00d (source: parameter file latency.path_t95)');
  });

  it('falls back to graph latency.path_t95 when parameter file latency config is missing', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g-path-t95-fallback',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', event_id: 'household-created', layout: { x: 0, y: 0 } } as any,
        { id: 'X', uuid: 'X', label: 'X', event_id: 'switch-registered', layout: { x: 0, y: 0 } } as any,
        { id: 'Y', uuid: 'Y', label: 'Y', event_id: 'switch-success', layout: { x: 0, y: 0 } } as any,
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'X',
          to: 'Y',
          p: {
            id: 'p1',
            connection: 'amplitude-prod',
            latency: {
              latency_parameter: true,
              anchor_node_id: 'A',
              t95: 13.12,
              // File latency config will be missing, so graph should be used.
              path_t95: 40,
            },
          },
          query: 'from(switch-registered).to(switch-success)',
        } as any,
      ],
    };

    // Same cached data as above (enables moment-matched estimate)
    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-prod',
      values: [
        {
          sliceDSL: 'cohort(household-created,10-Oct-25:12-Dec-25)',
          dates: ['10-Oct-25', '12-Dec-25'],
          n_daily: [1000, 1000],
          k_daily: [600, 600],
          median_lag_days: [6.4, 6.4],
          mean_lag_days: [6.8, 6.8],
          anchor_n_daily: [1500, 1500],
          anchor_median_lag_days: [10.25, 10.25],
          anchor_mean_lag_days: [10.51, 10.51],
          mean: 0.6,
          n: 2000,
          k: 1200,
          cohort_from: '10-Oct-25',
          cohort_to: '12-Dec-25',
          data_source: { retrieved_at: '2025-12-12T00:48:21.032Z', type: 'amplitude' },
        },
      ],
    });

    const report = await dataOperationsService.simulateRetrieveAllSlicesToMarkdown({
      graph,
      slices: ['cohort(-60d:)'],
      bustCache: false,
    });

    expect(report).toContain('anchor+edge estimate (moment-matched):');
    expect(report).toContain('effective path_t95 used for bounding: 40.00d (source: graph latency.path_t95)');
  });
});


