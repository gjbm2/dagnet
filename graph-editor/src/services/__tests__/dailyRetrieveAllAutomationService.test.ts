import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  pullLatestRemoteWins: vi.fn(),
  getCommittableFiles: vi.fn(),
  commitFiles: vi.fn(),
  executeRetrieveAllSlicesWithProgressToast: vi.fn(),
  startOperation: vi.fn(() => 'op-1'),
  addChild: vi.fn(),
  endOperation: vi.fn(),
  formatDateUK: vi.fn(() => '19-Jan-26'),
}));

vi.mock('../repositoryOperationsService', () => ({
  repositoryOperationsService: {
    pullLatestRemoteWins: hoisted.pullLatestRemoteWins,
    getCommittableFiles: hoisted.getCommittableFiles,
    commitFiles: hoisted.commitFiles,
  },
}));

vi.mock('../retrieveAllSlicesService', () => ({
  executeRetrieveAllSlicesWithProgressToast: hoisted.executeRetrieveAllSlicesWithProgressToast,
}));

vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    startOperation: hoisted.startOperation,
    addChild: hoisted.addChild,
    endOperation: hoisted.endOperation,
  },
}));

vi.mock('../../lib/dateFormat', () => ({
  formatDateUK: hoisted.formatDateUK,
}));

import { dailyRetrieveAllAutomationService } from '../dailyRetrieveAllAutomationService';

type FakeRepoFile = { id: string; dirty: boolean };

function createFakeRepoState(repository: string, branch: string, files: FakeRepoFile[]) {
  const state = {
    repository,
    branch,
    files: new Map(files.map((f) => [f.id, { ...f }])),
    lastPull: null as null | { repository: string; branch: string },
    lastCommit: null as null | { message: string; files: FakeRepoFile[] },
  };

  return {
    pull(repo: string, br: string) {
      if (repo !== state.repository || br !== state.branch) {
        throw new Error('pull repo/branch mismatch');
      }
      state.lastPull = { repository: repo, branch: br };
      return { conflictsResolved: 0 };
    },
    markDirty(fileId: string) {
      const existing = state.files.get(fileId) || { id: fileId, dirty: false };
      existing.dirty = true;
      state.files.set(fileId, existing);
    },
    getDirtyFiles() {
      return Array.from(state.files.values()).filter((f) => f.dirty);
    },
    commit(files: FakeRepoFile[], message: string, br: string, repo: string) {
      if (repo !== state.repository || br !== state.branch) {
        throw new Error('commit repo/branch mismatch');
      }
      const ids = new Set(files.map((f) => f.id));
      for (const f of state.files.values()) {
        if (ids.has(f.id)) f.dirty = false;
      }
      state.lastCommit = { message, files: files.map((f) => ({ ...f })) };
    },
    snapshot() {
      return {
        lastPull: state.lastPull,
        lastCommit: state.lastCommit,
        files: Array.from(state.files.values()).map((f) => ({ ...f })),
      };
    },
  };
}

describe('dailyRetrieveAllAutomationService', () => {
  let fakeRepo: ReturnType<typeof createFakeRepoState>;

  beforeEach(() => {
    for (const fn of Object.values(hoisted)) {
      if (typeof fn === 'function' && 'mockReset' in fn) (fn as any).mockReset();
    }
    fakeRepo = createFakeRepoState('repo-1', 'main', [{ id: 'parameter-a', dirty: false }]);
    hoisted.startOperation.mockReturnValue('op-1');
    hoisted.executeRetrieveAllSlicesWithProgressToast.mockImplementation(async () => {
      fakeRepo.markDirty('parameter-a');
      return {
        totalSlices: 1,
        totalItems: 1,
        totalSuccess: 1,
        totalErrors: 0,
        aborted: false,
      };
    });
    hoisted.pullLatestRemoteWins.mockImplementation(async (repository, branch) => {
      return fakeRepo.pull(repository, branch);
    });
    hoisted.getCommittableFiles.mockImplementation(async () => {
      return fakeRepo.getDirtyFiles();
    });
    hoisted.commitFiles.mockImplementation(async (files, message, branch, repository) => {
      fakeRepo.commit(files, message, branch, repository);
    });
  });

  it('runs pull → retrieve → commit in order', async () => {
    const order: string[] = [];

    hoisted.pullLatestRemoteWins.mockImplementation(async (repository, branch) => {
      order.push('pull');
      return fakeRepo.pull(repository, branch);
    });
    hoisted.executeRetrieveAllSlicesWithProgressToast.mockImplementation(async () => {
      order.push('retrieve');
      fakeRepo.markDirty('parameter-a');
      return { totalSlices: 1, totalItems: 1, totalSuccess: 1, totalErrors: 0, aborted: false };
    });
    hoisted.getCommittableFiles.mockImplementation(async () => {
      order.push('committable');
      return fakeRepo.getDirtyFiles();
    });
    hoisted.commitFiles.mockImplementation(async (files, message, branch, repository) => {
      order.push('commit');
      fakeRepo.commit(files, message, branch, repository);
    });

    await dailyRetrieveAllAutomationService.run({
      repository: 'repo-1',
      branch: 'main',
      graphFileId: 'graph-1',
      getGraph: () => ({ edges: [], nodes: [] } as any),
      setGraph: vi.fn(),
    });

    expect(order).toEqual(['pull', 'retrieve', 'committable', 'commit']);
    expect(hoisted.commitFiles).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'parameter-a' })],
      'Daily data refresh (1) - 19-Jan-26',
      'main',
      'repo-1',
      expect.any(Function),
      expect.any(Function)
    );

    const snapshot = fakeRepo.snapshot();
    expect(snapshot.lastPull).toEqual({ repository: 'repo-1', branch: 'main' });
    expect(snapshot.lastCommit?.message).toBe('Daily data refresh (1) - 19-Jan-26');
    expect(snapshot.files.every((f) => !f.dirty)).toBe(true);
  });

  it('skips commit when no committable files exist', async () => {
    hoisted.getCommittableFiles.mockResolvedValue([]);

    await dailyRetrieveAllAutomationService.run({
      repository: 'repo-1',
      branch: 'main',
      graphFileId: 'graph-1',
      getGraph: () => ({ edges: [], nodes: [] } as any),
      setGraph: vi.fn(),
    });

    expect(hoisted.commitFiles).toHaveBeenCalledTimes(0);
  });

  it('aborts after pull when shouldAbort flips true', async () => {
    const abort = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await dailyRetrieveAllAutomationService.run({
      repository: 'repo-1',
      branch: 'main',
      graphFileId: 'graph-1',
      getGraph: () => ({ edges: [], nodes: [] } as any),
      setGraph: vi.fn(),
      shouldAbort: abort,
    });

    expect(hoisted.executeRetrieveAllSlicesWithProgressToast).toHaveBeenCalledTimes(0);
    expect(hoisted.commitFiles).toHaveBeenCalledTimes(0);
  });

  it('retries commit when commitFiles requests retry', async () => {
    const error = new Error('please commit again');
    hoisted.commitFiles
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);

    await dailyRetrieveAllAutomationService.run({
      repository: 'repo-1',
      branch: 'main',
      graphFileId: 'graph-1',
      getGraph: () => ({ edges: [], nodes: [] } as any),
      setGraph: vi.fn(),
    });

    expect(hoisted.commitFiles).toHaveBeenCalledTimes(2);
  });
});
