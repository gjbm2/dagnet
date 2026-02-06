import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ------------------------------------------------------------
// Mocks
// ------------------------------------------------------------

const getBatchInventoryV2Mock = vi.fn();
const deleteSnapshotsMock = vi.fn();
const querySnapshotsFullMock = vi.fn();
const downloadTextFileMock = vi.fn();
const showConfirmMock = vi.fn(async () => true);

vi.mock('../../services/snapshotWriteService', () => ({
  getBatchInventoryV2: (...args: any[]) => getBatchInventoryV2Mock(...args),
  deleteSnapshots: (...args: any[]) => deleteSnapshotsMock(...args),
  querySnapshotsFull: (...args: any[]) => querySnapshotsFullMock(...args),
}));

vi.mock('../../services/downloadService', () => ({
  downloadTextFile: (...args: any[]) => downloadTextFileMock(...args),
}));

vi.mock('../../contexts/NavigatorContext', () => ({
  useNavigatorContext: () => ({
    state: {
      selectedRepo: 'r',
      selectedBranch: 'b',
    },
  }),
}));

vi.mock('../../contexts/DialogContext', () => ({
  useDialog: () => ({
    showConfirm: (...args: any[]) => showConfirmMock(...args),
  }),
}));

vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    getFile: () => ({
      data: {
        values: [
          { query_signature: '{"c":"sig-core","x":{}}', data_source: { retrieved_at: '2026-02-04T00:00:00Z' } },
        ],
      },
    }),
  },
}));

vi.mock('../../services/sessionLogService', () => ({
  sessionLogService: {
    startOperation: vi.fn(() => 'op'),
    addChild: vi.fn(),
    endOperation: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

// Important: this hook imports invalidateInventoryCache; keep it as a no-op
vi.mock('../useEdgeSnapshotInventory', () => ({
  invalidateInventoryCache: vi.fn(),
}));

import { useSnapshotsMenu } from '../useSnapshotsMenu';

describe('useSnapshotsMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBatchInventoryV2Mock.mockResolvedValue({
      'r-b-param-a': {
        overall_all_families: {
          earliest_anchor_day: '2025-12-01',
          latest_anchor_day: '2025-12-10',
          row_count: 10,
          unique_anchor_days: 10,
          unique_retrievals: 2,
          unique_retrieved_days: 10,
          earliest_retrieved_at: '2025-12-11T00:00:00Z',
          latest_retrieved_at: '2025-12-12T00:00:00Z',
        },
        current: {
          matched_family_id: 'fam1',
          match_mode: 'direct',
        },
        families: [
          {
            family_id: 'fam1',
            overall: {
              earliest_anchor_day: '2025-12-01',
              latest_anchor_day: '2025-12-10',
              row_count: 10,
              unique_anchor_days: 10,
              unique_retrievals: 2,
              unique_retrieved_days: 10,
              earliest_retrieved_at: '2025-12-11T00:00:00Z',
              latest_retrieved_at: '2025-12-12T00:00:00Z',
            },
            slices: [],
            member_core_hashes: ['h1'],
          },
        ],
        unlinked_core_hashes: [],
      },
    });
    deleteSnapshotsMock.mockResolvedValue({ success: true, deleted: 10 });
    querySnapshotsFullMock.mockResolvedValue({
      success: true,
      rows: [
        {
          param_id: 'r-b-param-a',
          core_hash: 'h',
          slice_key: '',
          anchor_day: '2025-12-01',
          retrieved_at: '2025-12-11T00:00:00Z',
          a: 1,
          x: 2,
          y: 3,
          median_lag_days: 4,
          mean_lag_days: 5,
          anchor_median_lag_days: 6,
          anchor_mean_lag_days: 7,
          onset_delta_days: 8,
        },
      ],
      count: 1,
    });
  });

  it('fetches inventory and exposes counts and matchedCoreHashes by objectId', async () => {
    const { result } = renderHook(() => useSnapshotsMenu(['param-a']));

    // Allow effect to run
    await act(async () => {});

    expect(getBatchInventoryV2Mock).toHaveBeenCalledWith(
      ['r-b-param-a'],
      { current_signatures: { 'r-b-param-a': '{"c":"sig-core","x":{}}' } },
    );
    expect(result.current.snapshotCounts['param-a']).toBe(10);
    expect(result.current.inventories['param-a']?.row_count).toBe(10);
    expect(result.current.matchedCoreHashes['param-a']).toEqual(['h1']);
  });

  it('downloads CSV for a param (param-wide, no core_hash filter)', async () => {
    const { result } = renderHook(() => useSnapshotsMenu(['param-a']));
    await act(async () => {});

    await act(async () => {
      await result.current.downloadSnapshotData('param-a');
    });

    expect(querySnapshotsFullMock).toHaveBeenCalled();
    // Param-wide: no core_hash in the request
    const queryArgs = querySnapshotsFullMock.mock.calls[0][0];
    expect(queryArgs.param_id).toBe('r-b-param-a');
    expect(queryArgs.core_hash).toBeUndefined();

    expect(downloadTextFileMock).toHaveBeenCalled();
    const args = downloadTextFileMock.mock.calls[0][0];
    expect(args.mimeType).toBe('text/csv');
    expect(args.content).toContain('param_id,core_hash,slice_key');
    expect(args.content).toContain('r-b-param-a');
  });

  it('downloads CSV scoped to core_hashes when provided', async () => {
    const { result } = renderHook(() => useSnapshotsMenu(['param-a']));
    await act(async () => {});

    await act(async () => {
      await result.current.downloadSnapshotData('param-a', ['h1']);
    });

    expect(querySnapshotsFullMock).toHaveBeenCalled();
    // Scoped: core_hash should be passed
    const queryArgs = querySnapshotsFullMock.mock.calls[0][0];
    expect(queryArgs.param_id).toBe('r-b-param-a');
    expect(queryArgs.core_hash).toBe('h1');

    expect(downloadTextFileMock).toHaveBeenCalled();
  });

  it('deletes snapshots param-wide with a confirmation prompt', async () => {
    const { result } = renderHook(() => useSnapshotsMenu(['param-a']));
    await act(async () => {});

    await act(async () => {
      await result.current.deleteSnapshots('param-a');
    });

    expect(showConfirmMock).toHaveBeenCalled();
    expect(deleteSnapshotsMock).toHaveBeenCalledWith('r-b-param-a');
  });

  it('deletes snapshots scoped to core_hashes when provided', async () => {
    const { result } = renderHook(() => useSnapshotsMenu(['param-a']));
    await act(async () => {});

    await act(async () => {
      await result.current.deleteSnapshots('param-a', ['h1']);
    });

    expect(showConfirmMock).toHaveBeenCalled();
    // Confirm message should mention "(current signature)"
    const confirmArgs = showConfirmMock.mock.calls[0][0];
    expect(confirmArgs.message).toContain('(current signature)');

    expect(deleteSnapshotsMock).toHaveBeenCalledWith('r-b-param-a', ['h1']);
  });

  it('deleteSnapshotsMany remains param-wide (no core_hash filter)', async () => {
    const { result } = renderHook(() => useSnapshotsMenu(['param-a']));
    await act(async () => {});

    await act(async () => {
      await result.current.deleteSnapshotsMany(['param-a']);
    });

    expect(showConfirmMock).toHaveBeenCalled();
    // Param-wide: no core_hashes argument
    expect(deleteSnapshotsMock).toHaveBeenCalledWith('r-b-param-a');
  });

  it('exposes empty matchedCoreHashes when no family matches', async () => {
    // Override mock to return inventory without a matched family
    getBatchInventoryV2Mock.mockResolvedValue({
      'r-b-param-a': {
        overall_all_families: {
          earliest_anchor_day: '2025-12-01',
          latest_anchor_day: '2025-12-10',
          row_count: 10,
          unique_anchor_days: 10,
          unique_retrievals: 2,
          unique_retrieved_days: 10,
          earliest_retrieved_at: '2025-12-11T00:00:00Z',
          latest_retrieved_at: '2025-12-12T00:00:00Z',
        },
        current: null,
        families: [],
        unlinked_core_hashes: [],
      },
    });

    const { result } = renderHook(() => useSnapshotsMenu(['param-a']));
    await act(async () => {});

    expect(result.current.matchedCoreHashes['param-a']).toEqual([]);
    // Count should fall back to overall_all_families
    expect(result.current.snapshotCounts['param-a']).toBe(10);
  });
});

