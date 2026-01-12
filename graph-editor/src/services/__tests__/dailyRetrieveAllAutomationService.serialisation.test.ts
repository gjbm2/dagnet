import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => {
  let pull1Resolve: ((v: any) => void) | null = null;

  const pull1 = new Promise((resolve) => {
    pull1Resolve = resolve;
  });

  return {
    pull1,
    pull1Resolve: () => pull1Resolve,
    pullLatestRemoteWins: vi.fn(),
    getCommittableFiles: vi.fn(),
    commitFiles: vi.fn(),
    retrieveExecute: vi.fn(),
    startOperation: vi.fn(() => 'op-1'),
    addChild: vi.fn(),
    endOperation: vi.fn(),
  };
});

vi.mock('../repositoryOperationsService', () => ({
  repositoryOperationsService: {
    pullLatestRemoteWins: hoisted.pullLatestRemoteWins,
    getCommittableFiles: hoisted.getCommittableFiles,
    commitFiles: hoisted.commitFiles,
  },
}));

vi.mock('../retrieveAllSlicesService', () => ({
  retrieveAllSlicesService: {
    execute: hoisted.retrieveExecute,
  },
}));

vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    startOperation: hoisted.startOperation,
    addChild: hoisted.addChild,
    endOperation: hoisted.endOperation,
  },
}));

describe('dailyRetrieveAllAutomationService (serialisation)', () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.pullLatestRemoteWins.mockReset();
    hoisted.getCommittableFiles.mockReset();
    hoisted.commitFiles.mockReset();
    hoisted.retrieveExecute.mockReset();
    hoisted.startOperation.mockReset();
    hoisted.addChild.mockReset();
    hoisted.endOperation.mockReset();

    // Default: no Web Locks API.
    (globalThis as any).navigator = undefined;
  });

  it('serialises concurrent run() calls (second does not start until first completes)', async () => {
    // First run blocks in pull.
    hoisted.pullLatestRemoteWins
      .mockImplementationOnce(async () => hoisted.pull1)
      .mockResolvedValueOnce({ conflictsResolved: 0 });

    hoisted.retrieveExecute.mockResolvedValue({ totalSuccess: 0, totalErrors: 0 } as any);
    hoisted.getCommittableFiles.mockResolvedValue([]);

    const { dailyRetrieveAllAutomationService } = await import('../dailyRetrieveAllAutomationService');

    const opts1 = {
      repository: 'repo-1',
      branch: 'main',
      graphFileId: 'graph-a',
      getGraph: () => ({ nodes: [], edges: [] } as any),
      setGraph: () => {},
    };
    const opts2 = { ...opts1, graphFileId: 'graph-b' };

    const p1 = dailyRetrieveAllAutomationService.run(opts1 as any);
    const p2 = dailyRetrieveAllAutomationService.run(opts2 as any);

    // Let microtasks flush: only first pull should have started.
    await Promise.resolve();
    expect(hoisted.pullLatestRemoteWins).toHaveBeenCalledTimes(1);

    // Unblock first run, then both should complete in order.
    const resolve1 = hoisted.pull1Resolve();
    expect(resolve1).not.toBeNull();
    resolve1?.({ conflictsResolved: 0 });

    await Promise.all([p1, p2]);
    expect(hoisted.pullLatestRemoteWins).toHaveBeenCalledTimes(2);
  });

  it('continues processing queue even if a run fails', async () => {
    hoisted.pullLatestRemoteWins
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ conflictsResolved: 0 });
    hoisted.retrieveExecute.mockResolvedValue({ totalSuccess: 0, totalErrors: 0 } as any);
    hoisted.getCommittableFiles.mockResolvedValue([]);

    const { dailyRetrieveAllAutomationService } = await import('../dailyRetrieveAllAutomationService');

    const base = {
      repository: 'repo-1',
      branch: 'main',
      getGraph: () => ({ nodes: [], edges: [] } as any),
      setGraph: () => {},
    };

    const p1 = dailyRetrieveAllAutomationService.run({ ...base, graphFileId: 'graph-a' } as any);
    const p2 = dailyRetrieveAllAutomationService.run({ ...base, graphFileId: 'graph-b' } as any);

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBeUndefined();
    expect(hoisted.pullLatestRemoteWins).toHaveBeenCalledTimes(2);
  });

  it('uses Web Locks API when available (cross-tab serialisation hook)', async () => {
    const locks = {
      request: vi.fn(async (_name: string, _opts: any, cb: () => Promise<any>) => {
        return await cb();
      }),
    };
    (globalThis as any).navigator = { locks };

    hoisted.pullLatestRemoteWins.mockResolvedValue({ conflictsResolved: 0 });
    hoisted.retrieveExecute.mockResolvedValue({ totalSuccess: 0, totalErrors: 0 } as any);
    hoisted.getCommittableFiles.mockResolvedValue([]);

    const { dailyRetrieveAllAutomationService } = await import('../dailyRetrieveAllAutomationService');
    await dailyRetrieveAllAutomationService.run({
      repository: 'repo-1',
      branch: 'main',
      graphFileId: 'graph-a',
      getGraph: () => ({ nodes: [], edges: [] } as any),
      setGraph: () => {},
    } as any);

    expect(locks.request).toHaveBeenCalledTimes(1);
    expect(locks.request).toHaveBeenCalledWith(
      'dagnet:daily-retrieveall',
      { mode: 'exclusive' },
      expect.any(Function)
    );
  });
});


