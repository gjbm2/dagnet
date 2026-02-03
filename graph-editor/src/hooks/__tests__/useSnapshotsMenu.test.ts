import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ------------------------------------------------------------
// Mocks
// ------------------------------------------------------------

const getBatchInventoryMock = vi.fn();
const deleteSnapshotsMock = vi.fn();
const querySnapshotsFullMock = vi.fn();
const downloadTextFileMock = vi.fn();
const showConfirmMock = vi.fn(async () => true);

vi.mock('../../services/snapshotWriteService', () => ({
  getBatchInventory: (...args: any[]) => getBatchInventoryMock(...args),
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
    getBatchInventoryMock.mockResolvedValue({
      'r-b-param-a': {
        has_data: true,
        param_id: 'r-b-param-a',
        earliest: '2025-12-01',
        latest: '2025-12-10',
        row_count: 10,
        unique_days: 10,
        unique_slices: 1,
        unique_hashes: 1,
        unique_retrievals: 2,
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

  it('fetches inventory and exposes counts by objectId', async () => {
    const { result } = renderHook(() => useSnapshotsMenu(['param-a']));

    // Allow effect to run
    await act(async () => {});

    expect(getBatchInventoryMock).toHaveBeenCalledWith(['r-b-param-a']);
    expect(result.current.snapshotCounts['param-a']).toBe(2);
    expect(result.current.inventories['param-a']?.row_count).toBe(10);
  });

  it('downloads CSV for a param with snapshot rows', async () => {
    const { result } = renderHook(() => useSnapshotsMenu(['param-a']));
    await act(async () => {});

    await act(async () => {
      await result.current.downloadSnapshotData('param-a');
    });

    expect(querySnapshotsFullMock).toHaveBeenCalled();
    expect(downloadTextFileMock).toHaveBeenCalled();
    const args = downloadTextFileMock.mock.calls[0][0];
    expect(args.mimeType).toBe('text/csv');
    expect(args.content).toContain('param_id,core_hash,slice_key');
    expect(args.content).toContain('r-b-param-a');
  });

  it('deletes snapshots with a confirmation prompt', async () => {
    const { result } = renderHook(() => useSnapshotsMenu(['param-a']));
    await act(async () => {});

    await act(async () => {
      await result.current.deleteSnapshots('param-a');
    });

    expect(showConfirmMock).toHaveBeenCalled();
    expect(deleteSnapshotsMock).toHaveBeenCalledWith('r-b-param-a');
  });
});

