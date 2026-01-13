import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  mockGetFile: vi.fn(),
  mockDbWorkspacesGet: vi.fn(),
  mockCredentialsLoad: vi.fn(),
  mockGitGetRemoteHeadSha: vi.fn(),
  mockStartOperation: vi.fn(),
  mockEndOperation: vi.fn(),
}));

vi.mock('../../contexts/TabContext', () => ({
  // NOTE: stalenessNudgeService reads from fileRegistry as a fast-path, then falls back to IndexedDB.
  fileRegistry: { getFile: hoisted.mockGetFile },
}));

vi.mock('../../db/appDatabase', () => ({
  db: {
    workspaces: {
      get: hoisted.mockDbWorkspacesGet,
    },
  },
}));

vi.mock('../../lib/credentials', () => ({
  credentialsManager: {
    loadCredentials: hoisted.mockCredentialsLoad,
  },
}));

vi.mock('../gitService', () => ({
  gitService: {
    setCredentials: vi.fn(),
    getRemoteHeadSha: hoisted.mockGitGetRemoteHeadSha,
  },
}));

vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    startOperation: hoisted.mockStartOperation,
    endOperation: hoisted.mockEndOperation,
  },
}));

import { stalenessNudgeService } from '../stalenessNudgeService';
import {
  STALENESS_NUDGE_RELOAD_AFTER_MS,
  STALENESS_NUDGE_REMOTE_CHECK_INTERVAL_MS,
} from '../../constants/staleness';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe('stalenessNudgeService', () => {
  beforeEach(() => {
    hoisted.mockGetFile.mockReset();
    hoisted.mockDbWorkspacesGet.mockReset();
    hoisted.mockCredentialsLoad.mockReset();
    hoisted.mockGitGetRemoteHeadSha.mockReset();
    hoisted.mockStartOperation.mockReset();
    hoisted.mockEndOperation.mockReset();

    hoisted.mockStartOperation.mockReturnValue('mock-op-id');
  });

  it('should prompt reload when last page load is older than threshold', () => {
    const storage = new MemoryStorage() as any;
    const t0 = 1_000_000;
    stalenessNudgeService.recordPageLoad(t0, storage);

    const shouldNot = stalenessNudgeService.shouldPromptReload(t0 + STALENESS_NUDGE_RELOAD_AFTER_MS - 1, storage);
    expect(shouldNot).toBe(false);

    const shouldYes = stalenessNudgeService.shouldPromptReload(t0 + STALENESS_NUDGE_RELOAD_AFTER_MS + 1, storage);
    expect(shouldYes).toBe(true);
  });

  it('should respect reload snooze window', () => {
    const storage = new MemoryStorage() as any;
    const t0 = 10_000_000;
    stalenessNudgeService.recordPageLoad(t0, storage);

    const now = t0 + STALENESS_NUDGE_RELOAD_AFTER_MS + 5_000;
    expect(stalenessNudgeService.shouldPromptReload(now, storage)).toBe(true);

    stalenessNudgeService.snooze('reload', undefined, now, storage);
    expect(stalenessNudgeService.isSnoozed('reload', undefined, now + 1, storage)).toBe(true);
  });

  it('should compute retrieve-all-slices staleness from connected parameter retrieved_at', async () => {
    const now = 2_000_000_000;

    hoisted.mockGetFile.mockImplementation((fileId: string) => {
      if (fileId === 'parameter-param-1') {
        return {
          data: {
            values: [
              // Must exceed the 24h threshold to be considered stale.
              { data_source: { retrieved_at: new Date(now - (25 * 60 * 60 * 1000)).toISOString() } },
            ],
          },
        };
      }
      return null;
    });

    const graph = {
      edges: [
        { uuid: 'edge-1', id: 'edge-1', p: { id: 'param-1' } },
      ],
      nodes: [],
    } as any;

    const res = await stalenessNudgeService.getRetrieveAllSlicesStalenessStatus(graph, now);
    expect(res.parameterCount).toBe(1);
    expect(res.staleParameterCount).toBe(1);
    expect(res.isStale).toBe(true);
  });

  it('should NOT consider retrieve-all-slices stale when graph has no connected parameters', async () => {
    const graph = { edges: [], nodes: [] } as any;
    const res = await stalenessNudgeService.getRetrieveAllSlicesStalenessStatus(graph, 123);
    expect(res.parameterCount).toBe(0);
    expect(res.isStale).toBe(false);
  });

  it('should report remote-ahead when remote HEAD differs from workspace commitSHA', async () => {
    hoisted.mockDbWorkspacesGet.mockResolvedValue({ commitSHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    hoisted.mockCredentialsLoad.mockResolvedValue({
      success: true,
      credentials: { defaultGitRepo: 'repo-1', git: [{ name: 'repo-1' }] },
    });
    hoisted.mockGitGetRemoteHeadSha.mockResolvedValue('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    const storage = new MemoryStorage() as any;
    const res = await stalenessNudgeService.getRemoteAheadStatus('repo-1', 'main', storage);
    expect(res.isRemoteAhead).toBe(true);
    expect(res.localSha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(res.remoteHeadSha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('should rate-limit remote head checks per repo-branch', () => {
    const storage = new MemoryStorage() as any;
    const repo = 'repo-1';
    const branch = 'main';
    const t0 = 123_000_000;

    // First time: should check.
    expect(stalenessNudgeService.shouldCheckRemoteHead(repo, branch, t0, storage)).toBe(true);
    stalenessNudgeService.markRemoteHeadChecked(repo, branch, t0, storage);

    // Within interval: should NOT check.
    expect(stalenessNudgeService.shouldCheckRemoteHead(repo, branch, t0 + STALENESS_NUDGE_REMOTE_CHECK_INTERVAL_MS - 1, storage)).toBe(false);

    // After interval: should check.
    expect(stalenessNudgeService.shouldCheckRemoteHead(repo, branch, t0 + STALENESS_NUDGE_REMOTE_CHECK_INTERVAL_MS + 1, storage)).toBe(true);
  });

  it('should persist dismissed remote SHA and clear it', () => {
    const storage = new MemoryStorage() as any;
    const repo = 'repo-1';
    const branch = 'main';
    const shaA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const shaB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    expect(stalenessNudgeService.isRemoteShaDismissed(repo, branch, shaA, storage)).toBe(false);

    stalenessNudgeService.dismissRemoteSha(repo, branch, shaA, storage);
    expect(stalenessNudgeService.isRemoteShaDismissed(repo, branch, shaA, storage)).toBe(true);
    expect(stalenessNudgeService.isRemoteShaDismissed(repo, branch, shaB, storage)).toBe(false);

    stalenessNudgeService.clearDismissedRemoteSha(repo, branch, storage);
    expect(stalenessNudgeService.isRemoteShaDismissed(repo, branch, shaA, storage)).toBe(false);
  });
});


