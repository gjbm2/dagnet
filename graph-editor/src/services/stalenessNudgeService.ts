import { db } from '../db/appDatabase';
import {
  STALENESS_NUDGE_MIN_REPEAT_MS,
  STALENESS_NUDGE_RELOAD_AFTER_MS,
  STALENESS_NUDGE_RETRIEVE_ALL_SLICES_AFTER_MS,
  STALENESS_PENDING_PLAN_MAX_AGE_MS,
  STALENESS_NUDGE_SNOOZE_MS,
  STALENESS_AUTOMATIC_MODE_DEFAULT,
  STALENESS_NUDGE_REMOTE_CHECK_INTERVAL_MS,
} from '../constants/staleness';
import { sessionLogService } from './sessionLogService';
import { credentialsManager } from '../lib/credentials';
import { gitService } from './gitService';
import type { GraphData } from '../types';
import { retrieveAllSlicesPlannerService } from './retrieveAllSlicesPlannerService';
import { fileRegistry } from '../contexts/TabContext';

type NudgeKind = 'reload' | 'git-pull' | 'retrieve-all-slices';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function safeNow(): number {
  return Date.now();
}

function safeGetNumber(storage: StorageLike, key: string): number | undefined {
  try {
    const v = storage.getItem(key);
    if (v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

function safeSetNumber(storage: StorageLike, key: string, value: number): void {
  try {
    storage.setItem(key, String(value));
  } catch {
    // ignore
  }
}

function safeRemove(storage: StorageLike, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // ignore
  }
}

function safeGetJson<T>(storage: StorageLike, key: string): T | undefined {
  try {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function safeSetJson(storage: StorageLike, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

function defaultStorage(): StorageLike {
  return window.localStorage;
}

const LS = {
  lastPageLoadAtMs: 'dagnet:staleness:lastPageLoadAtMs',
  lastPromptedAtMs: (kind: NudgeKind) => `dagnet:staleness:lastPromptedAtMs:${kind}`,
  lastDoneAtMs: (kind: NudgeKind) => `dagnet:staleness:lastDoneAtMs:${kind}`,
  snoozedUntilMs: (kind: NudgeKind, scope?: string) =>
    `dagnet:staleness:snoozedUntilMs:${kind}${scope ? `:${scope}` : ''}`,
  pendingPlan: 'dagnet:staleness:pendingPlan',
  automaticMode: 'dagnet:staleness:automaticMode',
  /** Tracks the last remote SHA that the user dismissed (per repo-branch). */
  dismissedRemoteSha: (repoBranch: string) => `dagnet:staleness:dismissedRemoteSha:${repoBranch}`,
  /** Tracks when we last checked remote HEAD (to rate-limit network calls). */
  lastRemoteCheckAtMs: (repoBranch: string) => `dagnet:staleness:lastRemoteCheckAtMs:${repoBranch}`,

  // =====================================================================
  // Share-live scoped remote-ahead tracking (must NOT depend on workspaces)
  // =====================================================================
  /** Tracks when we last checked remote HEAD for a share-live scope (rate limit). */
  shareLastRemoteCheckAtMs: (scopeKey: string) => `dagnet:share:staleness:lastRemoteCheckAtMs:${scopeKey}`,
  /** Tracks the last remote HEAD SHA we observed for a share-live scope ("last seen HEAD"). */
  shareLastSeenRemoteHeadSha: (scopeKey: string) => `dagnet:share:staleness:lastSeenRemoteHeadSha:${scopeKey}`,
  /** Tracks the last remote SHA dismissed for a share-live scope. */
  shareDismissedRemoteSha: (scopeKey: string) => `dagnet:share:staleness:dismissedRemoteSha:${scopeKey}`,
};

export interface RemoteAheadStatus {
  /** Local workspace SHA (what we last synced to). */
  localSha?: string;
  /** Remote HEAD SHA (what GitHub reports now). */
  remoteHeadSha?: string | null;
  /** True if remoteHeadSha exists and differs from localSha. */
  isRemoteAhead: boolean;
}

export interface RetrieveAllSlicesStalenessStatus {
  /** True if any connected parameter looks stale by simple retrieved_at age. */
  isStale: boolean;
  /** Count of parameter files evaluated. */
  parameterCount: number;
  /** Count of parameters considered stale. */
  staleParameterCount: number;
  /** Most recent retrieved_at timestamp seen across connected parameters (ms). */
  mostRecentRetrievedAtMs?: number;
}

export interface WorkspaceScope {
  repository: string;
  branch: string;
}

export interface ShareLiveScope {
  repository: string;
  branch: string;
  graph: string;
}

export interface PendingStalenessPlan {
  createdAtMs: number;
  repository?: string;
  branch?: string;
  graphFileId?: string;
  pullAllLatest?: boolean;
  retrieveAllSlices?: boolean;
}

class StalenessNudgeService {
  private static instance: StalenessNudgeService;

  static getInstance(): StalenessNudgeService {
    if (!StalenessNudgeService.instance) {
      StalenessNudgeService.instance = new StalenessNudgeService();
    }
    return StalenessNudgeService.instance;
  }

  recordPageLoad(nowMs: number = safeNow(), storage: StorageLike = defaultStorage()): void {
    safeSetNumber(storage, LS.lastPageLoadAtMs, nowMs);
  }

  /** UI-only helper: last page load timestamp used as "Reload last done". */
  getLastPageLoadAtMs(storage: StorageLike = defaultStorage()): number | undefined {
    return safeGetNumber(storage, LS.lastPageLoadAtMs);
  }

  shouldPromptReload(nowMs: number = safeNow(), storage: StorageLike = defaultStorage()): boolean {
    const lastLoad = safeGetNumber(storage, LS.lastPageLoadAtMs);
    if (!lastLoad) return false; // first load
    return nowMs - lastLoad > STALENESS_NUDGE_RELOAD_AFTER_MS && this.canPrompt('reload', nowMs, storage);
  }

  snooze(kind: NudgeKind, scope: string | undefined, nowMs: number, storage: StorageLike): void {
    safeSetNumber(storage, LS.snoozedUntilMs(kind, scope), nowMs + STALENESS_NUDGE_SNOOZE_MS);
  }

  isSnoozed(kind: NudgeKind, scope: string | undefined, nowMs: number, storage: StorageLike): boolean {
    const until = safeGetNumber(storage, LS.snoozedUntilMs(kind, scope));
    return until !== undefined && nowMs < until;
  }

  markPrompted(kind: NudgeKind, nowMs: number, storage: StorageLike): void {
    safeSetNumber(storage, LS.lastPromptedAtMs(kind), nowMs);
  }

  canPrompt(kind: NudgeKind, nowMs: number, storage: StorageLike): boolean {
    const last = safeGetNumber(storage, LS.lastPromptedAtMs(kind));
    if (last === undefined) return true;
    return nowMs - last > STALENESS_NUDGE_MIN_REPEAT_MS;
  }

  setPendingPlan(plan: PendingStalenessPlan, storage: StorageLike = defaultStorage()): void {
    safeSetJson(storage, LS.pendingPlan, plan);
  }

  getPendingPlan(storage: StorageLike = defaultStorage()): PendingStalenessPlan | undefined {
    const plan = safeGetJson<PendingStalenessPlan>(storage, LS.pendingPlan);
    if (!plan?.createdAtMs) return undefined;
    const age = Date.now() - plan.createdAtMs;
    if (age > STALENESS_PENDING_PLAN_MAX_AGE_MS) {
      safeRemove(storage, LS.pendingPlan);
      return undefined;
    }
    return plan;
  }

  clearPendingPlan(storage: StorageLike = defaultStorage()): void {
    safeRemove(storage, LS.pendingPlan);
  }

  /**
   * Safety: clear any state that should NEVER persist across a hard refresh (F5).
   * This prevents surprising background actions after reloads.
   */
  clearVolatileFlags(storage: StorageLike = defaultStorage()): void {
    safeRemove(storage, LS.pendingPlan);
    safeRemove(storage, LS.automaticMode);
  }

  getAutomaticMode(storage: StorageLike = defaultStorage()): boolean {
    const v = safeGetNumber(storage, LS.automaticMode);
    if (v === undefined) return STALENESS_AUTOMATIC_MODE_DEFAULT;
    return v === 1;
  }

  setAutomaticMode(enabled: boolean, storage: StorageLike = defaultStorage()): void {
    safeSetNumber(storage, LS.automaticMode, enabled ? 1 : 0);
  }

  /**
   * Determines if we should make a network call to check remote HEAD.
   * Rate-limited to avoid excessive network traffic.
   */
  shouldCheckRemoteHead(
    repository: string,
    branch: string,
    nowMs: number = safeNow(),
    storage: StorageLike = defaultStorage()
  ): boolean {
    const repoBranch = `${repository}-${branch}`;
    const lastCheck = safeGetNumber(storage, LS.lastRemoteCheckAtMs(repoBranch));
    if (lastCheck === undefined) return true;
    return nowMs - lastCheck > STALENESS_NUDGE_REMOTE_CHECK_INTERVAL_MS;
  }

  /**
   * Record that we just checked remote HEAD (for rate-limiting).
   */
  markRemoteHeadChecked(
    repository: string,
    branch: string,
    nowMs: number = safeNow(),
    storage: StorageLike = defaultStorage()
  ): void {
    const repoBranch = `${repository}-${branch}`;
    safeSetNumber(storage, LS.lastRemoteCheckAtMs(repoBranch), nowMs);
  }

  private shareScopeKey(scope: ShareLiveScope): string {
    // Keep key stable and readable; localStorage keys are per-origin.
    // Avoid secrets; repo/branch/graph are safe and already in the URL.
    return `${scope.repository}-${scope.branch}-${scope.graph}`;
  }

  shouldCheckShareRemoteHead(
    scope: ShareLiveScope,
    nowMs: number = safeNow(),
    storage: StorageLike = defaultStorage()
  ): boolean {
    const key = this.shareScopeKey(scope);
    const lastCheck = safeGetNumber(storage, LS.shareLastRemoteCheckAtMs(key));
    if (lastCheck === undefined) return true;
    return nowMs - lastCheck > STALENESS_NUDGE_REMOTE_CHECK_INTERVAL_MS;
  }

  markShareRemoteHeadChecked(
    scope: ShareLiveScope,
    nowMs: number = safeNow(),
    storage: StorageLike = defaultStorage()
  ): void {
    const key = this.shareScopeKey(scope);
    safeSetNumber(storage, LS.shareLastRemoteCheckAtMs(key), nowMs);
  }

  getShareLastSeenRemoteHeadSha(scope: ShareLiveScope, storage: StorageLike = defaultStorage()): string | undefined {
    const key = this.shareScopeKey(scope);
    try {
      const v = storage.getItem(LS.shareLastSeenRemoteHeadSha(key));
      return v || undefined;
    } catch {
      return undefined;
    }
  }

  recordShareLastSeenRemoteHeadSha(scope: ShareLiveScope, remoteHeadSha: string, storage: StorageLike = defaultStorage()): void {
    const key = this.shareScopeKey(scope);
    try {
      storage.setItem(LS.shareLastSeenRemoteHeadSha(key), remoteHeadSha);
    } catch {
      // ignore
    }
  }

  isShareRemoteShaDismissed(scope: ShareLiveScope, remoteSha: string, storage: StorageLike = defaultStorage()): boolean {
    const key = this.shareScopeKey(scope);
    try {
      const dismissed = storage.getItem(LS.shareDismissedRemoteSha(key));
      return dismissed === remoteSha;
    } catch {
      return false;
    }
  }

  dismissShareRemoteSha(scope: ShareLiveScope, remoteSha: string, storage: StorageLike = defaultStorage()): void {
    const key = this.shareScopeKey(scope);
    try {
      storage.setItem(LS.shareDismissedRemoteSha(key), remoteSha);
    } catch {
      // ignore
    }
  }

  clearDismissedShareRemoteSha(scope: ShareLiveScope, storage: StorageLike = defaultStorage()): void {
    const key = this.shareScopeKey(scope);
    safeRemove(storage, LS.shareDismissedRemoteSha(key));
  }

  /**
   * Check if a specific remote SHA has been dismissed by the user.
   * Used to implement "dismiss until next cron cycle" behaviour.
   */
  isRemoteShaDismissed(
    repository: string,
    branch: string,
    remoteSha: string,
    storage: StorageLike = defaultStorage()
  ): boolean {
    const repoBranch = `${repository}-${branch}`;
    try {
      const dismissed = storage.getItem(LS.dismissedRemoteSha(repoBranch));
      return dismissed === remoteSha;
    } catch {
      return false;
    }
  }

  /**
   * Dismiss a specific remote SHA. User won't be nudged for this SHA again
   * until a new commit appears on remote (i.e. next daily cron run).
   */
  dismissRemoteSha(
    repository: string,
    branch: string,
    remoteSha: string,
    storage: StorageLike = defaultStorage()
  ): void {
    const repoBranch = `${repository}-${branch}`;
    try {
      storage.setItem(LS.dismissedRemoteSha(repoBranch), remoteSha);
    } catch {
      // ignore
    }
  }

  /**
   * Clear dismissed SHA (e.g. after successful pull, so future changes are detected).
   */
  clearDismissedRemoteSha(
    repository: string,
    branch: string,
    storage: StorageLike = defaultStorage()
  ): void {
    const repoBranch = `${repository}-${branch}`;
    safeRemove(storage, LS.dismissedRemoteSha(repoBranch));
  }

  /**
   * Lightweight remote-ahead check (no pull).
   * Reuses the same primitive used by commit flow: compare workspace.commitSHA vs remote HEAD.
   * Automatically records the check timestamp for rate-limiting.
   */
  async getRemoteAheadStatus(
    repository: string,
    branch: string,
    storage: StorageLike = defaultStorage()
  ): Promise<RemoteAheadStatus> {
    const logOpId = sessionLogService.startOperation(
      'info',
      'git',
      'GIT_REMOTE_AHEAD_CHECK',
      `Checking remote HEAD for ${repository}/${branch}`,
      { repository, branch }
    );

    // Record that we checked (for rate-limiting)
    this.markRemoteHeadChecked(repository, branch, safeNow(), storage);

    try {
      const workspaceId = `${repository}-${branch}`;
      const workspace = await db.workspaces.get(workspaceId);

      const credsResult = await credentialsManager.loadCredentials();
      if (!credsResult.success || !credsResult.credentials) {
        sessionLogService.endOperation(logOpId, 'warning', 'Remote-ahead check skipped: no credentials');
        return { isRemoteAhead: false };
      }

      const gitCreds = credsResult.credentials.git.find((cred: any) => cred.name === repository);
      if (!gitCreds) {
        sessionLogService.endOperation(logOpId, 'warning', `Remote-ahead check skipped: no credentials for ${repository}`);
        return { isRemoteAhead: false };
      }

      gitService.setCredentials({ ...credsResult.credentials, defaultGitRepo: repository });

      const remoteHeadSha = await gitService.getRemoteHeadSha(branch);
      const localSha = workspace?.commitSHA;
      const isRemoteAhead = !!(remoteHeadSha && localSha && remoteHeadSha !== localSha);

      sessionLogService.endOperation(
        logOpId,
        'success',
        isRemoteAhead ? 'Remote is ahead' : 'Remote matches local',
        { repository, branch, localSha, remoteHeadSha, isRemoteAhead }
      );

      return { localSha, remoteHeadSha, isRemoteAhead };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      sessionLogService.endOperation(logOpId, 'warning', `Remote-ahead check failed: ${message}`);
      return { isRemoteAhead: false };
    }
  }

  /**
   * Lightweight remote-ahead check for share-live sessions (no workspace clone/pull).
   *
   * IMPORTANT:
   * - Share sessions must NOT depend on db.workspaces.commitSHA.
   * - We track "last seen remote HEAD SHA" per share identity (repo/branch/graph) in localStorage.
   *
   * Semantics:
   * - If we have never recorded a last-seen SHA for this share scope, we treat remote as "ahead"
   *   so we refresh once and establish the baseline.
   */
  async getShareRemoteAheadStatus(
    scope: ShareLiveScope,
    storage: StorageLike = defaultStorage()
  ): Promise<RemoteAheadStatus> {
    const { repository, branch, graph } = scope;
    const logOpId = sessionLogService.startOperation(
      'info',
      'git',
      'GIT_SHARE_REMOTE_AHEAD_CHECK',
      `Checking remote HEAD for share: ${repository}/${branch}/${graph}`,
      { repository, branch, graph }
    );

    this.markShareRemoteHeadChecked(scope, safeNow(), storage);

    try {
      const credsResult = await credentialsManager.loadCredentials();
      if (!credsResult.success || !credsResult.credentials) {
        sessionLogService.endOperation(logOpId, 'warning', 'Share remote-ahead check skipped: no credentials');
        return { isRemoteAhead: false };
      }

      const gitCreds = credsResult.credentials.git.find((cred: any) => cred.name === repository);
      if (!gitCreds) {
        sessionLogService.endOperation(logOpId, 'warning', `Share remote-ahead check skipped: no credentials for ${repository}`);
        return { isRemoteAhead: false };
      }

      gitService.setCredentials({ ...credsResult.credentials, defaultGitRepo: repository });

      const remoteHeadSha = await gitService.getRemoteHeadSha(branch);
      const localSha = this.getShareLastSeenRemoteHeadSha(scope, storage);
      const isRemoteAhead = !!(remoteHeadSha && (!localSha || remoteHeadSha !== localSha));

      sessionLogService.endOperation(
        logOpId,
        'success',
        isRemoteAhead ? 'Remote is ahead (share)' : 'Remote matches last-seen (share)',
        { repository, branch, graph, localSha, remoteHeadSha, isRemoteAhead }
      );

      return { localSha, remoteHeadSha, isRemoteAhead };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      sessionLogService.endOperation(logOpId, 'warning', `Share remote-ahead check failed: ${message}`);
      return { isRemoteAhead: false };
    }
  }

  /**
   * Simple staleness: for each connected parameter, look at most recent values[*].data_source.retrieved_at.
   * If any are older than STALENESS_NUDGE_RETRIEVE_ALL_SLICES_AFTER_MS, we consider the graph stale.
   *
   * IMPORTANT:
   * - IndexedDB is the source of truth for pulled files.
   * - FileRegistry is an in-memory cache and may not contain all parameter files immediately after pull.
   */
  async getRetrieveAllSlicesStalenessStatus(
    graph: GraphData,
    nowMs: number = safeNow(),
    workspace?: WorkspaceScope
  ): Promise<RetrieveAllSlicesStalenessStatus> {
    const targets = retrieveAllSlicesPlannerService.collectTargets(graph);
    const parameterTargets = targets.filter(t => t.type === 'parameter') as Array<Extract<typeof targets[number], { type: 'parameter' }>>;

    let mostRecentRetrievedAtMs: number | undefined;
    let staleCount = 0;

    for (const t of parameterTargets) {
      const logicalFileId = `parameter-${t.objectId}`;

      // Fast-path: in-memory cache (may be missing right after pull)
      const frFile = fileRegistry.getFile(logicalFileId) as any;
      let values = frFile?.data?.values;

      // Source of truth: IndexedDB (workspace-scoped if provided)
      if (!Array.isArray(values)) {
        try {
          let dbFile: any = await db.files.get(logicalFileId);

          if (!dbFile && workspace?.repository && workspace?.branch) {
            // Fall back to workspace-scoped search (supports prefixed IDs if present)
            dbFile = await db.files
              .where('source.repository')
              .equals(workspace.repository)
              .and(f => f.source?.branch === workspace.branch && (f.fileId === logicalFileId || f.fileId.endsWith(`-${logicalFileId}`)))
              .first();
          }

          values = dbFile?.data?.values;
        } catch {
          // Ignore IDB failures here; fall back to treating as stale below
          values = undefined;
        }
      }

      if (!Array.isArray(values) || values.length === 0) {
        // No values: treat as stale (Retrieve all slices will fill it).
        staleCount++;
        continue;
      }

      let paramMostRecent: number | undefined;
      for (const v of values) {
        const ra: string | undefined = v?.data_source?.retrieved_at;
        if (!ra) continue;
        const ms = new Date(ra).getTime();
        if (!Number.isFinite(ms)) continue;
        if (paramMostRecent === undefined || ms > paramMostRecent) paramMostRecent = ms;
      }

      if (paramMostRecent !== undefined) {
        if (mostRecentRetrievedAtMs === undefined || paramMostRecent > mostRecentRetrievedAtMs) {
          mostRecentRetrievedAtMs = paramMostRecent;
        }
        if (nowMs - paramMostRecent > STALENESS_NUDGE_RETRIEVE_ALL_SLICES_AFTER_MS) {
          staleCount++;
        }
      } else {
        staleCount++;
      }
    }

    return {
      isStale: staleCount > 0 && parameterTargets.length > 0,
      parameterCount: parameterTargets.length,
      staleParameterCount: staleCount,
      mostRecentRetrievedAtMs,
    };
  }

  // For tests / emergency reset
  _clearAll(storage: StorageLike = defaultStorage()): void {
    safeRemove(storage, LS.lastPageLoadAtMs);
    safeRemove(storage, LS.lastPromptedAtMs('reload'));
    safeRemove(storage, LS.lastPromptedAtMs('git-pull'));
    safeRemove(storage, LS.lastPromptedAtMs('retrieve-all-slices'));
    safeRemove(storage, LS.lastDoneAtMs('reload'));
    safeRemove(storage, LS.lastDoneAtMs('git-pull'));
    safeRemove(storage, LS.lastDoneAtMs('retrieve-all-slices'));
  }
}

export const stalenessNudgeService = StalenessNudgeService.getInstance();


