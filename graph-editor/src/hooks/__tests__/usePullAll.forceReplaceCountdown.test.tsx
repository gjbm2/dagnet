/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { usePullAll } from '../usePullAll';

const hoisted = vi.hoisted(() => ({
  pullLatest: vi.fn(),
  refreshItems: vi.fn(),
}));

vi.mock('../../contexts/NavigatorContext', () => ({
  useNavigatorContext: () => ({
    state: { selectedRepo: 'repo-1', selectedBranch: 'main' },
    operations: { refreshItems: hoisted.refreshItems },
  }),
}));

vi.mock('../../services/repositoryOperationsService', () => ({
  repositoryOperationsService: {
    pullLatest: hoisted.pullLatest,
  },
}));

vi.mock('../../services/sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn(),
  },
}));

function Harness() {
  const { pullAll, conflictModal, isPulling } = usePullAll();
  return (
    <div>
      <button onClick={() => void pullAll()} disabled={isPulling}>
        Pull All
      </button>
      {conflictModal}
    </div>
  );
}

describe('usePullAll - force-replace countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.pullLatest.mockReset();
    hoisted.refreshItems.mockReset();
  });

  it('auto-OKs after 10s and proceeds with force-replace apply', async () => {
    hoisted.pullLatest
      // preflight detect
      .mockResolvedValueOnce({
        success: true,
        forceReplaceRequests: [{ fileId: 'parameter-a', fileName: 'a.yaml', path: 'parameters/a.yaml' }],
      })
      // apply
      .mockResolvedValueOnce({ success: true, conflicts: [] });

    render(<Harness />);

    screen.getByRole('button', { name: 'Pull All' }).click();
    // Poll until modal appears (Testing Library async helpers rely on timers; we control them explicitly).
    for (let i = 0; i < 200; i++) {
      if (screen.queryByText('Force replace requested')) break;
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
    }
    expect(screen.getByText('Force replace requested')).toBeTruthy();

    // Countdown starts at 10. Advance beyond it.
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    for (let i = 0; i < 200; i++) {
      if (hoisted.pullLatest.mock.calls.length >= 2) break;
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
    }
    expect(hoisted.pullLatest).toHaveBeenCalledTimes(2);

    expect(hoisted.pullLatest.mock.calls[1]?.[2]).toEqual({
      forceReplace: { mode: 'apply', allowFileIds: ['parameter-a'] },
    });

    vi.useRealTimers();
  });

  it('Cancel chooses merge normally (no allowFileIds) and proceeds', async () => {
    hoisted.pullLatest
      // preflight detect
      .mockResolvedValueOnce({
        success: true,
        forceReplaceRequests: [{ fileId: 'parameter-a', fileName: 'a.yaml', path: 'parameters/a.yaml' }],
      })
      // apply attempt with allowFileIds empty
      .mockResolvedValueOnce({ success: true, conflicts: [] });

    render(<Harness />);

    screen.getByRole('button', { name: 'Pull All' }).click();
    for (let i = 0; i < 200; i++) {
      if (screen.queryByText('Force replace requested')) break;
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
    }
    expect(screen.getByText('Force replace requested')).toBeTruthy();

    screen.getByRole('button', { name: 'Cancel (merge normally)' }).click();

    for (let i = 0; i < 200; i++) {
      if (hoisted.pullLatest.mock.calls.length >= 2) break;
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
    }
    expect(hoisted.pullLatest).toHaveBeenCalledTimes(2);

    expect(hoisted.pullLatest.mock.calls[1]?.[2]).toEqual({
      forceReplace: { mode: 'apply', allowFileIds: [] },
    });

    // Ensure auto-expiry does not re-trigger after cancel.
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.resolve();
    expect(hoisted.pullLatest).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

