import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  mockGetFile: vi.fn(),
  mockDbWorkspacesGet: vi.fn(),
  mockCredentialsLoad: vi.fn(),
  mockGitGetRemoteHeadSha: vi.fn(),
  mockStartOperation: vi.fn(),
  mockEndOperation: vi.fn(),
  mockInfo: vi.fn(),
  mockWarning: vi.fn(),
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
    info: hoisted.mockInfo,
    warning: hoisted.mockWarning,
  },
}));

import { stalenessNudgeService } from '../stalenessNudgeService';
import {
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
    hoisted.mockInfo.mockReset();

    hoisted.mockStartOperation.mockReturnValue('mock-op-id');
  });

  it('audits deployed-version refresh: stamps last-checked and updates cached version when fetch succeeds', async () => {
    const storage = new MemoryStorage() as any;
    const now = 123_000;

    // Mock fetch(version.json)
    const fetchSpy = vi
      .spyOn(globalThis as any, 'fetch')
      .mockResolvedValue({
        ok: true,
        json: async () => ({ version: '2.0.0-beta' }),
      } as any);

    await stalenessNudgeService.refreshRemoteAppVersionIfDue(now, storage);

    // Cache written
    expect(storage.getItem('dagnet:staleness:lastSeenRemoteAppVersion')).toBe('2.0.0-beta');
    // Rate-limit stamp written
    expect(storage.getItem('dagnet:staleness:lastAppVersionCheckAtMs')).toBe(String(now));

    // Session log audit entries emitted (prod-visible)
    expect(hoisted.mockInfo).toHaveBeenCalledWith(
      'session',
      'STALENESS_APP_VERSION_CHECK_STAMP',
      expect.any(String),
      undefined,
      expect.objectContaining({ key: 'dagnet:staleness:lastAppVersionCheckAtMs', nowMs: now })
    );
    expect(hoisted.mockInfo).toHaveBeenCalledWith(
      'session',
      'STALENESS_APP_VERSION_CACHE_SET',
      expect.any(String),
      undefined,
      expect.objectContaining({ key: 'dagnet:staleness:lastSeenRemoteAppVersion', next: '2.0.0-beta' })
    );

    fetchSpy.mockRestore();
  });

  it('audits snooze writes with correct key scoping', () => {
    const storage = new MemoryStorage() as any;
    const now = 1_000_000;
    stalenessNudgeService.snooze('git-pull', 'repo-1-main', now, storage);

    const key = 'dagnet:staleness:snoozedUntilMs:git-pull:repo-1-main';
    const untilRaw = storage.getItem(key);
    expect(untilRaw).toBeTruthy();

    expect(hoisted.mockInfo).toHaveBeenCalledWith(
      'session',
      'STALENESS_SNOOZE_SET',
      expect.any(String),
      undefined,
      expect.objectContaining({ kind: 'git-pull', scope: 'repo-1-main', key })
    );
  });

  it('should cache remote deployed app version and compare to local (newer)', () => {
    const storage = new MemoryStorage() as any;
    // Simulate version.json having been fetched already.
    storage.setItem('dagnet:staleness:lastSeenRemoteAppVersion', '2.0.0-beta');

    expect(stalenessNudgeService.isRemoteAppVersionNewerThanLocal('1.0.0-beta', storage)).toBe(true);
    expect(stalenessNudgeService.isRemoteAppVersionNewerThanLocal('2.0.0-beta', storage)).toBe(false);
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

  it('should NOT consider retrieve-all-slices stale when graph marker is stale but parameter retrieved_at is fresh', async () => {
    const now = 2_000_000_000;
    const fresh = new Date(now - 60_000).toISOString();

    // Marker is older than threshold (25h ago)
    const marker = now - (25 * 60 * 60 * 1000);

    hoisted.mockGetFile.mockImplementation((fileId: string) => {
      if (fileId === 'parameter-param-1') {
        return {
          data: {
            values: [{ data_source: { retrieved_at: fresh } }],
          },
        };
      }
      return null;
    });

    const graph = {
      edges: [{ uuid: 'edge-1', id: 'edge-1', p: { id: 'param-1' } }],
      nodes: [],
      metadata: { last_retrieve_all_slices_success_at_ms: marker },
    } as any;

    const res = await stalenessNudgeService.getRetrieveAllSlicesStalenessStatus(graph, now);
    expect(res.isStale).toBe(false);
    expect(res.lastSuccessfulRunAtMs).toBe(marker);
    expect(res.mostRecentRetrievedAtMs).toBe(new Date(fresh).getTime());
  });

  it('computes retrieve freshness against a specific target slice DSL when provided (chart semantics)', async () => {
    const now = 2_000_000_000;
    const fresh = new Date(now - 60_000).toISOString();
    const stale = new Date(now - (25 * 60 * 60 * 1000)).toISOString();

    hoisted.mockGetFile.mockImplementation((fileId: string) => {
      if (fileId === 'parameter-param-1') {
        return {
          data: {
            values: [
              // Stale slice (google)
              { sliceDSL: 'context(channel:google)', data_source: { retrieved_at: stale } },
              // Fresh slice (influencer)
              { sliceDSL: 'context(channel:influencer)', data_source: { retrieved_at: fresh } },
            ],
          },
        };
      }
      return null;
    });

    const graph = {
      edges: [{ uuid: 'edge-1', id: 'edge-1', p: { id: 'param-1' } }],
      nodes: [],
      metadata: { last_retrieve_all_slices_success_at_ms: now - (25 * 60 * 60 * 1000) },
    } as any;

    // Against influencer slice: should be fresh.
    const resFresh = await stalenessNudgeService.getRetrieveAllSlicesStalenessStatus(
      graph,
      now,
      undefined,
      'context(channel:influencer).window(1-Dec-25:7-Dec-25)'
    );
    expect(resFresh.isStale).toBe(false);
    expect(resFresh.mostRecentRetrievedAtMs).toBe(new Date(fresh).getTime());

    // Against google slice: should be stale.
    const resStale = await stalenessNudgeService.getRetrieveAllSlicesStalenessStatus(
      graph,
      now,
      undefined,
      'context(channel:google).window(1-Dec-25:7-Dec-25)'
    );
    expect(resStale.isStale).toBe(true);
    expect(resStale.mostRecentRetrievedAtMs).toBe(new Date(stale).getTime());
  });

  it('should NOT consider retrieve-all-slices stale when graph has no connected parameters', async () => {
    const graph = { edges: [], nodes: [] } as any;
    const res = await stalenessNudgeService.getRetrieveAllSlicesStalenessStatus(graph, 123);
    expect(res.parameterCount).toBe(0);
    expect(res.isStale).toBe(false);
  });

  it('should NOT consider retrieve-all-slices stale when connected parameters have never been retrieved (no retrieved_at)', async () => {
    const now = 2_000_000_000;

    hoisted.mockGetFile.mockImplementation((fileId: string) => {
      if (fileId === 'parameter-param-1') {
        return { data: { values: [] } };
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
    expect(res.staleParameterCount).toBe(0);
    expect(res.mostRecentRetrievedAtMs).toBeUndefined();
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

  it('represents a deterministic multi-client drift scenario: pull due blocks retrieve; after pull, retrieve not due', () => {
    const now = 1_000_000;
    const scope = { type: 'workspace' as const, repository: 'repo-1', branch: 'main' };

    // Client B before pull: sees remote ahead, retrieve looks stale
    const planBefore = stalenessNudgeService.computeNudgingPlanFromSignals({
      nowMs: now,
      entity: { type: 'graph', graphFileId: 'graph-1' },
      scope,
      signals: {
        localAppVersion: '1.0.0-beta',
        remoteAppVersion: '1.0.0-beta',
        git: { isRemoteAhead: true, localSha: 'aaa', remoteHeadSha: 'bbb' },
        retrieve: { isStale: true, parameterCount: 3, staleParameterCount: 1, mostRecentRetrievedAtMs: now - 86_400_001 },
      },
    });
    expect(planBefore.steps['git-pull'].status).toBe('due');
    expect(planBefore.steps['retrieve-all-slices'].status).toBe('blocked');

    // After simulated pull: remote not ahead and retrieve freshness is within window
    const planAfter = stalenessNudgeService.computeNudgingPlanFromSignals({
      nowMs: now,
      entity: { type: 'graph', graphFileId: 'graph-1' },
      scope,
      signals: {
        localAppVersion: '1.0.0-beta',
        remoteAppVersion: '1.0.0-beta',
        git: { isRemoteAhead: false, localSha: 'bbb', remoteHeadSha: 'bbb' },
        retrieve: { isStale: false, parameterCount: 3, staleParameterCount: 0, mostRecentRetrievedAtMs: now - 60_000 },
      },
    });
    expect(planAfter.steps['git-pull'].status).toBe('not_due');
    expect(planAfter.steps['retrieve-all-slices'].status).toBe('not_due');
  });

  it('should rate-limit share remote head checks per repo-branch-graph', () => {
    const storage = new MemoryStorage() as any;
    const scope = { repository: 'repo-1', branch: 'main', graph: 'g-1' };
    const t0 = 123_000_000;

    expect(stalenessNudgeService.shouldCheckShareRemoteHead(scope, t0, storage)).toBe(true);
    stalenessNudgeService.markShareRemoteHeadChecked(scope, t0, storage);

    expect(stalenessNudgeService.shouldCheckShareRemoteHead(scope, t0 + STALENESS_NUDGE_REMOTE_CHECK_INTERVAL_MS - 1, storage)).toBe(false);
    expect(stalenessNudgeService.shouldCheckShareRemoteHead(scope, t0 + STALENESS_NUDGE_REMOTE_CHECK_INTERVAL_MS + 1, storage)).toBe(true);
  });

  it('should report share remote-ahead when remote HEAD differs from last-seen (and treat missing last-seen as ahead)', async () => {
    hoisted.mockCredentialsLoad.mockResolvedValue({
      success: true,
      credentials: { defaultGitRepo: 'repo-1', git: [{ name: 'repo-1' }] },
    });
    hoisted.mockGitGetRemoteHeadSha.mockResolvedValue('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    const storage = new MemoryStorage() as any;
    const scope = { repository: 'repo-1', branch: 'main', graph: 'my-graph' };

    // No last-seen: should be treated as ahead (bootstrap refresh).
    const res1 = await stalenessNudgeService.getShareRemoteAheadStatus(scope, storage);
    expect(res1.isRemoteAhead).toBe(true);
    expect(res1.localSha).toBeUndefined();
    expect(res1.remoteHeadSha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    // Record last-seen and check again with same remote: not ahead.
    stalenessNudgeService.recordShareLastSeenRemoteHeadSha(scope, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', storage);
    const res2 = await stalenessNudgeService.getShareRemoteAheadStatus(scope, storage);
    expect(res2.isRemoteAhead).toBe(false);
    expect(res2.localSha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(res2.remoteHeadSha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    // Remote changes: ahead.
    hoisted.mockGitGetRemoteHeadSha.mockResolvedValue('cccccccccccccccccccccccccccccccccccccccc');
    const res3 = await stalenessNudgeService.getShareRemoteAheadStatus(scope, storage);
    expect(res3.isRemoteAhead).toBe(true);
    expect(res3.localSha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(res3.remoteHeadSha).toBe('cccccccccccccccccccccccccccccccccccccccc');
  });

  describe('computeNudgingPlanFromSignals (pure cascade)', () => {
    it('marks reload Due when deployed version is newer, blocking pull and retrieve behind reload (strict cascade)', () => {
      const plan = stalenessNudgeService.computeNudgingPlanFromSignals({
        nowMs: 123,
        entity: { type: 'graph', graphFileId: 'graph-1' },
        scope: { type: 'workspace', repository: 'repo-1', branch: 'main' },
        signals: {
          localAppVersion: '1.0.0-beta',
          remoteAppVersion: '2.0.0-beta',
          git: { isRemoteAhead: true, localSha: 'aaa', remoteHeadSha: 'bbb' },
          retrieve: { isStale: true, parameterCount: 1, staleParameterCount: 1, mostRecentRetrievedAtMs: 1 },
        },
      });

      expect(plan.steps.reload.status).toBe('due');
      expect(plan.steps['git-pull'].status).toBe('blocked');
      expect(plan.steps['git-pull'].blockedBy).toBe('reload');
      expect(plan.steps['retrieve-all-slices'].status).toBe('blocked');
      expect(plan.steps['retrieve-all-slices'].blockedBy).toBe('reload');
      expect(plan.recommendedChecked).toEqual({ reload: true, 'git-pull': false, 'retrieve-all-slices': false });
    });

    it('marks pull Due when remote is ahead and update is not due, blocking retrieve', () => {
      const plan = stalenessNudgeService.computeNudgingPlanFromSignals({
        nowMs: 123,
        entity: { type: 'graph', graphFileId: 'graph-1' },
        scope: { type: 'workspace', repository: 'repo-1', branch: 'main' },
        signals: {
          localAppVersion: '1.0.0-beta',
          remoteAppVersion: '1.0.0-beta',
          git: { isRemoteAhead: true, localSha: 'aaa', remoteHeadSha: 'bbb' },
          retrieve: { isStale: true, parameterCount: 1, staleParameterCount: 1, mostRecentRetrievedAtMs: 1 },
        },
      });

      expect(plan.steps.reload.status).toBe('not_due');
      expect(plan.steps['git-pull'].status).toBe('due');
      expect(plan.steps['retrieve-all-slices'].status).toBe('blocked');
      expect(plan.steps['retrieve-all-slices'].blockedBy).toBe('git-pull');
      expect(plan.recommendedChecked).toEqual({ reload: false, 'git-pull': true, 'retrieve-all-slices': false });
    });

    it('allows retrieve Due when git is unknown (retrieve without pull), if retrieve is stale and update is not due', () => {
      const plan = stalenessNudgeService.computeNudgingPlanFromSignals({
        nowMs: 123,
        entity: { type: 'graph', graphFileId: 'graph-1' },
        scope: { type: 'workspace', repository: 'repo-1', branch: 'main' },
        signals: {
          localAppVersion: '1.0.0-beta',
          remoteAppVersion: '1.0.0-beta',
          // git signal intentionally omitted => Unknown
          retrieve: { isStale: true, parameterCount: 1, staleParameterCount: 1, mostRecentRetrievedAtMs: 1 },
        },
      });

      expect(plan.steps.reload.status).toBe('not_due');
      expect(plan.steps['git-pull'].status).toBe('unknown');
      expect(plan.steps['retrieve-all-slices'].status).toBe('due');
      expect(plan.steps['retrieve-all-slices'].retrieveWithoutPull).toBe(true);
      // Safety: retrieve is never pre-selected.
      expect(plan.recommendedChecked).toEqual({ reload: false, 'git-pull': false, 'retrieve-all-slices': false });
    });

    it('treats remote deployed version older than local as not due (staged rollout)', () => {
      const plan = stalenessNudgeService.computeNudgingPlanFromSignals({
        nowMs: 123,
        entity: { type: 'graph', graphFileId: 'graph-1' },
        scope: { type: 'workspace', repository: 'repo-1', branch: 'main' },
        signals: {
          localAppVersion: '2.0.0-beta',
          remoteAppVersion: '1.0.0-beta',
          git: { isRemoteAhead: false, localSha: 'aaa', remoteHeadSha: 'aaa' },
          retrieve: { isStale: false, parameterCount: 1, staleParameterCount: 0, mostRecentRetrievedAtMs: 1 },
        },
      });

      expect(plan.steps.reload.status).toBe('not_due');
      expect(plan.steps.reload.reason.toLowerCase()).toContain('staged rollout');
    });

    it('applies scoped-global pull: two entities in same repo/branch both see pull Due when git is ahead', () => {
      const scope = { type: 'workspace' as const, repository: 'repo-1', branch: 'main' };
      const signals = {
        localAppVersion: '1.0.0-beta',
        remoteAppVersion: '1.0.0-beta',
        git: { isRemoteAhead: true, localSha: 'aaa', remoteHeadSha: 'bbb' },
        retrieve: { isStale: false, parameterCount: 1, staleParameterCount: 0, mostRecentRetrievedAtMs: 1 },
      };

      const planA = stalenessNudgeService.computeNudgingPlanFromSignals({
        nowMs: 123,
        entity: { type: 'graph', graphFileId: 'graph-a' },
        scope,
        signals,
      });
      const planB = stalenessNudgeService.computeNudgingPlanFromSignals({
        nowMs: 123,
        entity: { type: 'graph', graphFileId: 'graph-b' },
        scope,
        signals,
      });

      expect(planA.steps['git-pull'].status).toBe('due');
      expect(planB.steps['git-pull'].status).toBe('due');
    });
  });

  describe('runSelectedStalenessActions (orchestration)', () => {
    it('blocks pull/retrieve when an update is due (strict cascade)', async () => {
      const storage = new MemoryStorage() as any;
      // Simulate: remote deployed is newer than local client.
      storage.setItem('dagnet:staleness:lastSeenRemoteAppVersion', '2.0.0-beta');

      const pullAll = vi.fn(async () => {});
      const reloadPage = vi.fn(() => {});

      await stalenessNudgeService.runSelectedStalenessActions({
        selected: new Set(['git-pull', 'retrieve-all-slices', 'reload']),
        nowMs: 123,
        storage,
        localAppVersion: '1.0.0-beta',
        repository: 'repo-1',
        branch: 'main',
        graphFileId: 'graph-1',
        shareGraph: undefined,
        isShareLive: false,
        automaticMode: false,
        pullAll,
        requestRetrieveAllSlices: vi.fn(),
        executeRetrieveAllSlicesHeadless: vi.fn(async () => {}),
        openSessionLogTab: vi.fn(),
        getGraphData: vi.fn(() => ({ edges: [], nodes: [] } as any)),
        setGraphData: vi.fn(),
        reloadPage,
        notify: vi.fn(),
      });

      // Strict cascade: do not run pull/retrieve on out-of-date client; only reload.
      expect(pullAll).toHaveBeenCalledTimes(0);
      expect(reloadPage).toHaveBeenCalledTimes(1);
    });

    it('runs pull then reload when both are selected (explicit user intent)', async () => {
      const storage = new MemoryStorage() as any;
      const pullAll = vi.fn(async () => {});
      const reloadPage = vi.fn(() => {});

      await stalenessNudgeService.runSelectedStalenessActions({
        selected: new Set(['reload', 'git-pull']),
        nowMs: 123,
        storage,
        localAppVersion: '1.0.0-beta',
        repository: 'repo-1',
        branch: 'main',
        graphFileId: 'graph-1',
        shareGraph: undefined,
        isShareLive: false,
        automaticMode: false,
        pullAll,
        requestRetrieveAllSlices: vi.fn(),
        executeRetrieveAllSlicesHeadless: vi.fn(async () => {}),
        openSessionLogTab: vi.fn(),
        getGraphData: vi.fn(() => ({ edges: [], nodes: [] } as any)),
        setGraphData: vi.fn(),
        reloadPage,
        notify: vi.fn(),
      });

      expect(pullAll).toHaveBeenCalledTimes(1);
      expect(reloadPage).toHaveBeenCalledTimes(1);
      expect(hoisted.mockInfo).toHaveBeenCalledWith(
        'session',
        'STALENESS_RUN_THEN_RELOAD',
        expect.any(String),
        undefined,
        expect.objectContaining({ repository: 'repo-1', branch: 'main', wantsPull: true })
      );
    });

    it('skips retrieve after pull if pull brought fresh retrieval state', async () => {
      const storage = new MemoryStorage() as any;
      const pullAll = vi.fn(async () => {});
      const requestRetrieveAllSlices = vi.fn();
      const executeRetrieveAllSlicesHeadless = vi.fn(async () => {});

      const getGraphData = vi.fn(() => ({ edges: [], nodes: [] } as any));
      const stalenessSpy = vi
        .spyOn(stalenessNudgeService, 'getRetrieveAllSlicesStalenessStatus')
        .mockResolvedValueOnce({
          isStale: false,
          parameterCount: 1,
          staleParameterCount: 0,
          mostRecentRetrievedAtMs: 123,
        });

      await stalenessNudgeService.runSelectedStalenessActions({
        selected: new Set(['git-pull', 'retrieve-all-slices']),
        nowMs: 123,
        storage,
        localAppVersion: '1.0.0-beta',
        repository: 'repo-1',
        branch: 'main',
        graphFileId: 'graph-1',
        shareGraph: undefined,
        isShareLive: false,
        automaticMode: false,
        pullAll,
        requestRetrieveAllSlices,
        executeRetrieveAllSlicesHeadless,
        openSessionLogTab: vi.fn(),
        getGraphData,
        setGraphData: vi.fn(),
        reloadPage: vi.fn(),
        notify: vi.fn(),
      });

      expect(pullAll).toHaveBeenCalledTimes(1);
      expect(stalenessSpy).toHaveBeenCalledTimes(1);
      expect(requestRetrieveAllSlices).toHaveBeenCalledTimes(0);
      expect(executeRetrieveAllSlicesHeadless).toHaveBeenCalledTimes(0);
    });

    it('requests retrieve via UI flow when retrieve is selected (non-headless)', async () => {
      const storage = new MemoryStorage() as any;
      const requestRetrieveAllSlices = vi.fn();

      await stalenessNudgeService.runSelectedStalenessActions({
        selected: new Set(['retrieve-all-slices']),
        nowMs: 123,
        storage,
        localAppVersion: '1.0.0-beta',
        repository: 'repo-1',
        branch: 'main',
        graphFileId: 'graph-1',
        shareGraph: undefined,
        isShareLive: false,
        automaticMode: false,
        pullAll: vi.fn(async () => {}),
        requestRetrieveAllSlices,
        executeRetrieveAllSlicesHeadless: vi.fn(async () => {}),
        openSessionLogTab: vi.fn(),
        getGraphData: vi.fn(() => ({ edges: [], nodes: [] } as any)),
        setGraphData: vi.fn(),
        reloadPage: vi.fn(),
        notify: vi.fn(),
      });

      expect(requestRetrieveAllSlices).toHaveBeenCalledTimes(1);
    });

    it('runs headless retrieve when automaticMode is enabled and retrieve is selected', async () => {
      const storage = new MemoryStorage() as any;
      const openSessionLogTab = vi.fn();
      const executeRetrieveAllSlicesHeadless = vi.fn(async () => {});

      await stalenessNudgeService.runSelectedStalenessActions({
        selected: new Set(['retrieve-all-slices']),
        nowMs: 123,
        storage,
        localAppVersion: '1.0.0-beta',
        repository: 'repo-1',
        branch: 'main',
        graphFileId: 'graph-1',
        shareGraph: undefined,
        isShareLive: false,
        automaticMode: true,
        pullAll: vi.fn(async () => {}),
        requestRetrieveAllSlices: vi.fn(),
        executeRetrieveAllSlicesHeadless,
        openSessionLogTab,
        getGraphData: vi.fn(() => ({ edges: [], nodes: [] } as any)),
        setGraphData: vi.fn(),
        reloadPage: vi.fn(),
        notify: vi.fn(),
      });

      expect(openSessionLogTab).toHaveBeenCalledTimes(1);
      expect(executeRetrieveAllSlicesHeadless).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleStalenessAutoPull (countdown expiry)', () => {
    it('uses remote-wins pull in dashboard mode when repo is available', async () => {
      const pullLatestRemoteWins = vi.fn(async () => {});
      const pullAll = vi.fn(async () => {});

      await stalenessNudgeService.handleStalenessAutoPull({
        nowMs: 1,
        storage: new MemoryStorage() as any,
        repository: 'repo-1',
        branch: 'main',
        shareGraph: undefined,
        isShareLive: false,
        isDashboardMode: true,
        pullAll,
        pullLatestRemoteWins,
        notify: vi.fn(),
      });

      expect(pullLatestRemoteWins).toHaveBeenCalledTimes(1);
      expect(pullAll).toHaveBeenCalledTimes(0);
    });
  });
});


