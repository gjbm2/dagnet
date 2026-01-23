import { db } from '../db/appDatabase';
import {
  STALENESS_NUDGE_MIN_REPEAT_MS,
  STALENESS_NUDGE_RETRIEVE_ALL_SLICES_AFTER_MS,
  STALENESS_PENDING_PLAN_MAX_AGE_MS,
  STALENESS_NUDGE_SNOOZE_MS,
  STALENESS_AUTOMATIC_MODE_DEFAULT,
  STALENESS_NUDGE_REMOTE_CHECK_INTERVAL_MS,
  STALENESS_NUDGE_APP_VERSION_CHECK_INTERVAL_MS,
} from '../constants/staleness';
import { sessionLogService } from './sessionLogService';
import { credentialsManager } from '../lib/credentials';
import { gitService } from './gitService';
import type { GraphData } from '../types';
import { retrieveAllSlicesPlannerService } from './retrieveAllSlicesPlannerService';
import { fileRegistry } from '../contexts/TabContext';
import { isolateSlice } from './sliceIsolation';

type NudgeKind = 'reload' | 'git-pull' | 'retrieve-all-slices';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const NUDGING_PLAN_ENGINE_VERSION = 'nudging-redux-v2';

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

type ParsedSemver = { major: number; minor: number; patch: number; prerelease?: string };

function parseSemverLoose(v: string): ParsedSemver | null {
  // Accept: "1.2.6-beta", "v1.2.6-beta", "1.2.6", "1.2.6b" (legacy display), etc.
  const cleaned = String(v || '').trim().replace(/^v/i, '');
  // Convert legacy "1.2.6b" → "1.2.6-beta" for comparison
  const normalised = cleaned.replace(/(\d+\.\d+\.\d+)\s*b$/i, '$1-beta');

  const m = normalised.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;

  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;

  return { major, minor, patch, prerelease: m[4] };
}

function isRemoteSemverNewer(remote: string, local: string): boolean {
  const r = parseSemverLoose(remote);
  const l = parseSemverLoose(local);
  if (!r || !l) return false;
  if (r.major !== l.major) return r.major > l.major;
  if (r.minor !== l.minor) return r.minor > l.minor;
  if (r.patch !== l.patch) return r.patch > l.patch;

  // Same base version; treat prerelease as not newer for our purposes.
  return false;
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

  /** Tracks when we last checked version.json (rate limit). */
  lastAppVersionCheckAtMs: 'dagnet:staleness:lastAppVersionCheckAtMs',
  /** Tracks the last version.json "version" we observed ("last seen deployed version"). */
  lastSeenRemoteAppVersion: 'dagnet:staleness:lastSeenRemoteAppVersion',
  /** Guard against reload loops: last remote version we auto-reloaded for (dashboard/unattended). */
  lastAutoReloadedRemoteAppVersion: 'dagnet:staleness:lastAutoReloadedRemoteAppVersion',

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
  /** If present, graph-level marker for last successful Retrieve All Slices completion (ms). */
  lastSuccessfulRunAtMs?: number;
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

export type NudgingStepKey = 'reload' | 'git-pull' | 'retrieve-all-slices';
export type NudgingStepStatus = 'due' | 'blocked' | 'unknown' | 'not_due';

export interface NudgingStep {
  key: NudgingStepKey;
  status: NudgingStepStatus;
  /** Short, user-facing explanation suitable for Session Log and UI. */
  reason: string;
  /** Which step blocks this step (only when status === 'blocked'). */
  blockedBy?: NudgingStepKey;
  /**
   * True when retrieve is being allowed despite unknown git state (per policy decision),
   * and execution must not attempt any git operations as part of that retrieve.
   */
  retrieveWithoutPull?: boolean;
}

export interface NudgingPlan {
  /** The entity being evaluated (graph tab or chart tab). */
  entity:
    | { type: 'graph'; graphFileId?: string }
    | { type: 'chart'; chartFileId?: string; parentGraphFileId?: string; effectiveQueryDsl?: string };
  /** Optional scope (workspace or share-live). */
  scope?: { type: 'workspace'; repository: string; branch: string } | { type: 'share-live'; repository: string; branch: string; graph: string };
  steps: Record<NudgingStepKey, NudgingStep>;
  /** Recommended defaults for interactive checkbox UI (pure suggestion; execution is separate). */
  recommendedChecked: Record<NudgingStepKey, boolean>;
}

export interface NudgingSignals {
  localAppVersion: string;
  /** Cached deployed version (from version.json). If missing, client update status is Unknown. */
  remoteAppVersion?: string;
  /**
   * Remote-ahead signal.
   * - undefined => Unknown (not checked / not possible)
   * - isRemoteAhead=false => Not due
   * - isRemoteAhead=true => Due
   */
  git?: Pick<RemoteAheadStatus, 'isRemoteAhead' | 'localSha' | 'remoteHeadSha'>;
  /** Retrieve freshness signal for the target entity. If missing, retrieve status is Unknown. */
  retrieve?: RetrieveAllSlicesStalenessStatus;
}

export interface CollectedUpdateSignal {
  /** True if deployed version is known to be newer than local. */
  isOutdated: boolean;
  /** True if reload is Due (not snoozed, outdated, and prompt allowed). */
  reloadDue: boolean;
  /** Cached deployed version (if present). */
  remoteAppVersion?: string;
}

export interface CollectedGitSignal {
  gitPullDue: boolean;
  detectedRemoteSha: string | null;
  gitPullLastDoneAtMs?: number;
  /** Workspace SHA used as "local" reference for the remote-ahead check (may be undefined if unknown). */
  localSha?: string;
  /** Remote HEAD SHA observed during the check (or last known; null/undefined when not checked). */
  remoteHeadSha?: string | null;
  /** Timestamp (ms) when remote HEAD was last checked for this scope (rate-limit stamp). */
  lastRemoteCheckedAtMs?: number;
}

export interface CollectedRetrieveSignal {
  retrieveDue: boolean;
  retrieveMostRecentRetrievedAtMs?: number;
}

function isRemoteSemverOlder(remote: string, local: string): boolean {
  const r = parseSemverLoose(remote);
  const l = parseSemverLoose(local);
  if (!r || !l) return false;
  if (r.major !== l.major) return r.major < l.major;
  if (r.minor !== l.minor) return r.minor < l.minor;
  if (r.patch !== l.patch) return r.patch < l.patch;
  // Same base version; treat prerelease as not older for our purposes.
  return false;
}

export interface RunSelectedStalenessActionsOptions {
  selected: Set<NudgingStepKey>;
  nowMs: number;
  storage: StorageLike;

  // Context
  localAppVersion: string;
  repository?: string;
  branch: string;
  /** Share-live identity graph name (not fileId), if applicable. */
  shareGraph?: string;
  /** Active graph fileId, if applicable. */
  graphFileId?: string;
  isShareLive: boolean;
  /** "Automatic mode" here means: headless retrieve execution for this user-initiated run. */
  automaticMode: boolean;

  // Operations (callback pattern: service owns orchestration, callers provide UI integrations)
  pullAll: () => Promise<void>;
  refreshLiveShareToLatest?: () => Promise<{ success: boolean; error?: string }>;
  pullLatestRemoteWins?: () => Promise<void>;

  // Retrieve integrations
  requestRetrieveAllSlices: () => void;
  executeRetrieveAllSlicesHeadless: (opts: { toastId: string; toastLabel: string }) => Promise<void>;
  openSessionLogTab: () => void;
  getGraphData: () => GraphData | null;
  setGraphData: (g: GraphData | null) => void;

  // UI integrations
  reloadPage: () => void;
  notify: (kind: 'success' | 'error', message: string) => void;
}

export interface HandleStalenessAutoPullOptions {
  nowMs: number;
  storage: StorageLike;
  repository?: string;
  branch: string;
  shareGraph?: string;
  isShareLive: boolean;
  isDashboardMode: boolean;

  pullAll: () => Promise<void>;
  pullLatestRemoteWins?: () => Promise<void>;
  refreshLiveShareToLatest?: () => Promise<{ success: boolean; error?: string }>;
  notify: (kind: 'success' | 'error', message: string) => void;
}

class StalenessNudgeService {
  private static instance: StalenessNudgeService;

  static getInstance(): StalenessNudgeService {
    if (!StalenessNudgeService.instance) {
      StalenessNudgeService.instance = new StalenessNudgeService();
    }
    return StalenessNudgeService.instance;
  }

  private audit(
    operationType: Parameters<typeof sessionLogService.info>[0],
    code: string,
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    sessionLogService.info(operationType, code, message, undefined, {
      planEngineVersion: NUDGING_PLAN_ENGINE_VERSION,
      ...metadata,
    });
  }

  recordPageLoad(nowMs: number = safeNow(), storage: StorageLike = defaultStorage()): void {
    safeSetNumber(storage, LS.lastPageLoadAtMs, nowMs);
    this.audit('session', 'STALENESS_PAGE_LOAD_STAMP', 'Recorded page load baseline', {
      key: LS.lastPageLoadAtMs,
      nowMs,
    });
  }

  /** UI-only helper: last page load timestamp used as "Reload last done". */
  getLastPageLoadAtMs(storage: StorageLike = defaultStorage()): number | undefined {
    return safeGetNumber(storage, LS.lastPageLoadAtMs);
  }

  /**
   * Determines if we should fetch version.json.
   * Rate-limited to avoid excessive network traffic.
   */
  shouldCheckRemoteAppVersion(nowMs: number = safeNow(), storage: StorageLike = defaultStorage()): boolean {
    const lastCheck = safeGetNumber(storage, LS.lastAppVersionCheckAtMs);
    if (lastCheck === undefined) return true;
    return nowMs - lastCheck > STALENESS_NUDGE_APP_VERSION_CHECK_INTERVAL_MS;
  }

  private markRemoteAppVersionChecked(nowMs: number, storage: StorageLike): void {
    safeSetNumber(storage, LS.lastAppVersionCheckAtMs, nowMs);
    this.audit('session', 'STALENESS_APP_VERSION_CHECK_STAMP', 'Recorded deployed-version check timestamp', {
      key: LS.lastAppVersionCheckAtMs,
      nowMs,
    });
  }

  getCachedRemoteAppVersion(storage: StorageLike = defaultStorage()): string | undefined {
    try {
      const v = storage.getItem(LS.lastSeenRemoteAppVersion);
      return v || undefined;
    } catch {
      return undefined;
    }
  }

  private setCachedRemoteAppVersion(version: string, storage: StorageLike): void {
    try {
      const prev = storage.getItem(LS.lastSeenRemoteAppVersion) || undefined;
      storage.setItem(LS.lastSeenRemoteAppVersion, version);
      if (prev !== version) {
        this.audit('session', 'STALENESS_APP_VERSION_CACHE_SET', 'Updated cached deployed client version', {
          key: LS.lastSeenRemoteAppVersion,
          previous: prev,
          next: version,
        });
      }
    } catch {
      // ignore
    }
  }

  isRemoteAppVersionDifferent(localVersion: string, storage: StorageLike = defaultStorage()): boolean {
    const remote = this.getCachedRemoteAppVersion(storage);
    if (!remote) return false;
    return remote !== localVersion;
  }

  isRemoteAppVersionNewerThanLocal(localVersion: string, storage: StorageLike = defaultStorage()): boolean {
    const remote = this.getCachedRemoteAppVersion(storage);
    if (!remote) return false;
    return isRemoteSemverNewer(remote, localVersion);
  }

  private getLastAutoReloadedRemoteAppVersion(storage: StorageLike): string | undefined {
    try {
      const v = storage.getItem(LS.lastAutoReloadedRemoteAppVersion);
      return v || undefined;
    } catch {
      return undefined;
    }
  }

  private markAutoReloadedRemoteAppVersion(remoteVersion: string, storage: StorageLike): void {
    try {
      storage.setItem(LS.lastAutoReloadedRemoteAppVersion, remoteVersion);
      this.audit('session', 'STALENESS_APP_AUTO_RELOAD_GUARD_SET', 'Recorded auto-reload guard for deployed version', {
        key: LS.lastAutoReloadedRemoteAppVersion,
        remoteVersion,
      });
    } catch {
      // ignore
    }
  }

  /**
   * Dashboard/unattended behaviour: if a newer client is deployed, reload automatically (once per remote version).
   * Returns true if it triggered a reload attempt.
   */
  maybeAutoReloadForUpdate(
    localVersion: string,
    nowMs: number = safeNow(),
    storage: StorageLike = defaultStorage()
  ): boolean {
    const remoteVersion = this.getCachedRemoteAppVersion(storage);
    if (!remoteVersion) return false;
    // Only auto-reload when the deployed client is newer than us.
    if (!isRemoteSemverNewer(remoteVersion, localVersion)) return false;

    const lastAuto = this.getLastAutoReloadedRemoteAppVersion(storage);
    if (lastAuto === remoteVersion) return false;

    // Mark before reloading to avoid loops if the reload fails for any reason.
    this.markAutoReloadedRemoteAppVersion(remoteVersion, storage);

    sessionLogService.warning(
      'session',
      'APP_AUTO_RELOAD_FOR_UPDATE',
      'New client version detected in unattended mode; reloading page',
      undefined,
      { localVersion, remoteVersion, nowMs }
    );

    if (typeof window !== 'undefined' && window.location?.reload) {
      window.location.reload();
      return true;
    }
    return false;
  }

  /**
   * Fetch deployed version.json and cache it in localStorage.
   * Never throws; failures simply leave the cached value unchanged.
   */
  async refreshRemoteAppVersionIfDue(
    nowMs: number = safeNow(),
    storage: StorageLike = defaultStorage()
  ): Promise<void> {
    if (!this.shouldCheckRemoteAppVersion(nowMs, storage)) return;

    // Mark early so repeated callers don't dogpile if fetch is slow/fails.
    this.markRemoteAppVersionChecked(nowMs, storage);

    try {
      // Respect Vite base path; ensures this works under non-root deployments.
      const baseUrl = (import.meta as any)?.env?.BASE_URL || '/';
      const url = `${baseUrl.replace(/\/?$/, '/') }version.json`;

      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;

      const data = (await res.json()) as { version?: unknown };
      const version = typeof data?.version === 'string' ? data.version : undefined;
      if (!version) return;

      this.setCachedRemoteAppVersion(version, storage);
    } catch {
      // ignore (offline, blocked, etc.)
    }
  }

  snooze(kind: NudgeKind, scope: string | undefined, nowMs: number, storage: StorageLike): void {
    const untilMs = nowMs + STALENESS_NUDGE_SNOOZE_MS;
    const key = LS.snoozedUntilMs(kind, scope);
    safeSetNumber(storage, key, untilMs);
    this.audit('session', 'STALENESS_SNOOZE_SET', 'Snoozed staleness nudge', {
      kind,
      scope,
      key,
      nowMs,
      untilMs,
    });
  }

  isSnoozed(kind: NudgeKind, scope: string | undefined, nowMs: number, storage: StorageLike): boolean {
    const until = safeGetNumber(storage, LS.snoozedUntilMs(kind, scope));
    return until !== undefined && nowMs < until;
  }

  markPrompted(kind: NudgeKind, nowMs: number, storage: StorageLike): void {
    const key = LS.lastPromptedAtMs(kind);
    safeSetNumber(storage, key, nowMs);
    this.audit('session', 'STALENESS_PROMPT_MARK', 'Recorded that a staleness prompt was shown', {
      kind,
      key,
      nowMs,
    });
  }

  canPrompt(kind: NudgeKind, nowMs: number, storage: StorageLike): boolean {
    const last = safeGetNumber(storage, LS.lastPromptedAtMs(kind));
    if (last === undefined) return true;
    return nowMs - last > STALENESS_NUDGE_MIN_REPEAT_MS;
  }

  /**
   * Service-owned: refresh deployed version (rate-limited) and compute the update signal.
   *
   * NOTE: This method MAY update localStorage (version cache + last-checked stamp).
   * It is intentionally separated from pure plan computation.
   */
  async collectUpdateSignal(opts: {
    nowMs: number;
    localAppVersion: string;
    storage: StorageLike;
    reloadSnoozed: boolean;
  }): Promise<CollectedUpdateSignal> {
    const { nowMs, localAppVersion, storage, reloadSnoozed } = opts;

    if (!reloadSnoozed) {
      await this.refreshRemoteAppVersionIfDue(nowMs, storage);
    }

    const isOutdated = this.isRemoteAppVersionNewerThanLocal(localAppVersion, storage);
    const reloadDue = !reloadSnoozed && isOutdated && this.canPrompt('reload', nowMs, storage);
    const remoteAppVersion = this.getCachedRemoteAppVersion(storage);
    return { isOutdated, reloadDue, remoteAppVersion };
  }

  /**
   * Service-owned: compute git remote-ahead signal (workspace or share-live), respecting:
   * - snooze
   * - prompt cooldown
   * - rate-limited remote head checks
   * - dismiss-by-SHA behaviour
   */
  async collectGitSignal(opts: {
    nowMs: number;
    storage: StorageLike;
    repository?: string;
    branch: string;
    isShareLive: boolean;
    shareGraph?: string;
  }): Promise<CollectedGitSignal> {
    const { nowMs, storage, repository, branch, isShareLive, shareGraph } = opts;

    let gitPullDue = false;
    let detectedRemoteSha: string | null = null;
    let gitPullLastDoneAtMs: number | undefined;
    let localSha: string | undefined;
    let remoteHeadSha: string | null | undefined;
    let lastRemoteCheckedAtMs: number | undefined;

    if (!repository) {
      return { gitPullDue, detectedRemoteSha, gitPullLastDoneAtMs, localSha, remoteHeadSha, lastRemoteCheckedAtMs };
    }

    const scopeKey = isShareLive && shareGraph ? `${repository}-${branch}-${shareGraph}` : `${repository}-${branch}`;
    if (this.isSnoozed('git-pull', scopeKey, nowMs, storage)) {
      return { gitPullDue, detectedRemoteSha, gitPullLastDoneAtMs, localSha, remoteHeadSha, lastRemoteCheckedAtMs };
    }
    if (!this.canPrompt('git-pull', nowMs, storage)) {
      return { gitPullDue, detectedRemoteSha, gitPullLastDoneAtMs, localSha, remoteHeadSha, lastRemoteCheckedAtMs };
    }

    if (isShareLive && shareGraph) {
      // Last checked timestamp (if any), even if we don't check in this run.
      lastRemoteCheckedAtMs = safeGetNumber(storage, LS.shareLastRemoteCheckAtMs(this.shareScopeKey({ repository, branch, graph: shareGraph })));
      const shouldCheck = this.shouldCheckShareRemoteHead({ repository, branch, graph: shareGraph }, nowMs, storage);
      if (shouldCheck) {
        const status = await this.getShareRemoteAheadStatus({ repository, branch, graph: shareGraph }, storage);
        localSha = status.localSha;
        remoteHeadSha = status.remoteHeadSha;
        // Refresh last-checked stamp after any attempted check.
        lastRemoteCheckedAtMs = safeGetNumber(storage, LS.shareLastRemoteCheckAtMs(this.shareScopeKey({ repository, branch, graph: shareGraph })));
        if (status.isRemoteAhead && status.remoteHeadSha) {
          if (!this.isShareRemoteShaDismissed({ repository, branch, graph: shareGraph }, status.remoteHeadSha, storage)) {
            gitPullDue = true;
            detectedRemoteSha = status.remoteHeadSha;
          }
        }
      }

      // Share-live "last done" is best-effort from the graph file's sync metadata.
      try {
        const f = fileRegistry.getFile(`graph-${shareGraph}`) as any;
        gitPullLastDoneAtMs = typeof f?.lastSynced === 'number' ? f.lastSynced : undefined;
      } catch {
        gitPullLastDoneAtMs = undefined;
      }
    } else {
      // Last checked timestamp (if any), even if we don't check in this run.
      lastRemoteCheckedAtMs = safeGetNumber(storage, LS.lastRemoteCheckAtMs(`${repository}-${branch}`));
      const shouldCheck = this.shouldCheckRemoteHead(repository, branch, nowMs, storage);
      if (shouldCheck) {
        const status = await this.getRemoteAheadStatus(repository, branch, storage);
        localSha = status.localSha;
        remoteHeadSha = status.remoteHeadSha;
        // Refresh last-checked stamp after any attempted check.
        lastRemoteCheckedAtMs = safeGetNumber(storage, LS.lastRemoteCheckAtMs(`${repository}-${branch}`));
        if (status.isRemoteAhead && status.remoteHeadSha) {
          if (!this.isRemoteShaDismissed(repository, branch, status.remoteHeadSha, storage)) {
            gitPullDue = true;
            detectedRemoteSha = status.remoteHeadSha;
          }
        }
      }

      // Workspace "last done" from IndexedDB workspace metadata.
      try {
        const ws = await db.workspaces.get(`${repository}-${branch}`);
        gitPullLastDoneAtMs = typeof ws?.lastSynced === 'number' ? ws.lastSynced : undefined;
      } catch {
        gitPullLastDoneAtMs = undefined;
      }
    }

    return { gitPullDue, detectedRemoteSha, gitPullLastDoneAtMs, localSha, remoteHeadSha, lastRemoteCheckedAtMs };
  }

  /**
   * Service-owned: compute retrieve staleness for a graph entity (or chart via parent graph + target slice DSL).
   * Respects snooze + prompt cooldown; does not attempt any git operations.
   */
  async collectRetrieveSignal(opts: {
    nowMs: number;
    storage: StorageLike;
    retrieveTargetGraphFileId?: string;
    repository?: string;
    branch: string;
    targetSliceDsl?: string;
  }): Promise<CollectedRetrieveSignal> {
    const { nowMs, storage, retrieveTargetGraphFileId, repository, branch, targetSliceDsl } = opts;

    let retrieveDue = false;
    let retrieveMostRecentRetrievedAtMs: number | undefined;

    if (!retrieveTargetGraphFileId) return { retrieveDue, retrieveMostRecentRetrievedAtMs };
    if (this.isSnoozed('retrieve-all-slices', retrieveTargetGraphFileId, nowMs, storage)) {
      return { retrieveDue, retrieveMostRecentRetrievedAtMs };
    }
    if (!this.canPrompt('retrieve-all-slices', nowMs, storage)) {
      return { retrieveDue, retrieveMostRecentRetrievedAtMs };
    }

    const graphFile = fileRegistry.getFile(retrieveTargetGraphFileId) as any;
    if (graphFile?.type !== 'graph' || !graphFile?.data) return { retrieveDue, retrieveMostRecentRetrievedAtMs };

    const staleness = await this.getRetrieveAllSlicesStalenessStatus(
      graphFile.data,
      nowMs,
      repository ? { repository, branch } : undefined,
      targetSliceDsl
    );
    retrieveDue = staleness.isStale;

    const a = staleness.lastSuccessfulRunAtMs;
    const b = staleness.mostRecentRetrievedAtMs;
    retrieveMostRecentRetrievedAtMs = a === undefined ? b : b === undefined ? a : Math.max(a, b);

    return { retrieveDue, retrieveMostRecentRetrievedAtMs };
  }

  setPendingPlan(plan: PendingStalenessPlan, storage: StorageLike = defaultStorage()): void {
    safeSetJson(storage, LS.pendingPlan, plan);
    this.audit('session', 'STALENESS_PENDING_PLAN_SET', 'Stored pending staleness plan', {
      key: LS.pendingPlan,
      createdAtMs: plan?.createdAtMs,
      repository: plan?.repository,
      branch: plan?.branch,
      graphFileId: plan?.graphFileId,
      pullAllLatest: plan?.pullAllLatest,
      retrieveAllSlices: plan?.retrieveAllSlices,
    });
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
    this.audit('session', 'STALENESS_PENDING_PLAN_CLEAR', 'Cleared pending staleness plan', {
      key: LS.pendingPlan,
    });
  }

  /**
   * Safety: clear any state that should NEVER persist across a hard refresh (F5).
   * This prevents surprising background actions after reloads.
   */
  clearVolatileFlags(storage: StorageLike = defaultStorage()): void {
    safeRemove(storage, LS.pendingPlan);
    safeRemove(storage, LS.automaticMode);
    this.audit(
      'session',
      'STALENESS_VOLATILE_FLAGS_CLEAR',
      'Cleared volatile staleness flags (safety: never persist across refresh)',
      {
        keys: [LS.pendingPlan, LS.automaticMode],
      }
    );
  }

  getAutomaticMode(storage: StorageLike = defaultStorage()): boolean {
    const v = safeGetNumber(storage, LS.automaticMode);
    if (v === undefined) return STALENESS_AUTOMATIC_MODE_DEFAULT;
    return v === 1;
  }

  setAutomaticMode(enabled: boolean, storage: StorageLike = defaultStorage()): void {
    safeSetNumber(storage, LS.automaticMode, enabled ? 1 : 0);
    this.audit('session', 'STALENESS_AUTOMATIC_MODE_SET', 'Set staleness automatic mode (per-run, non-persistent across refresh)', {
      key: LS.automaticMode,
      enabled,
    });
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
    const key = LS.lastRemoteCheckAtMs(repoBranch);
    safeSetNumber(storage, key, nowMs);
    this.audit('git', 'GIT_REMOTE_HEAD_CHECK_STAMP', 'Recorded remote HEAD check timestamp (rate-limit)', {
      repository,
      branch,
      repoBranch,
      key,
      nowMs,
    });
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
    const lsKey = LS.shareLastRemoteCheckAtMs(key);
    safeSetNumber(storage, lsKey, nowMs);
    this.audit('git', 'GIT_SHARE_REMOTE_HEAD_CHECK_STAMP', 'Recorded share remote HEAD check timestamp (rate-limit)', {
      repository: scope.repository,
      branch: scope.branch,
      graph: scope.graph,
      scopeKey: key,
      key: lsKey,
      nowMs,
    });
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
      this.audit('git', 'GIT_SHARE_LAST_SEEN_HEAD_SET', 'Recorded share last-seen remote HEAD SHA', {
        repository: scope.repository,
        branch: scope.branch,
        graph: scope.graph,
        scopeKey: key,
        key: LS.shareLastSeenRemoteHeadSha(key),
        remoteHeadSha,
      });
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
      this.audit('session', 'STALENESS_SHARE_REMOTE_SHA_DISMISS', 'Dismissed share remote SHA (won’t prompt again until remote changes)', {
        repository: scope.repository,
        branch: scope.branch,
        graph: scope.graph,
        scopeKey: key,
        key: LS.shareDismissedRemoteSha(key),
        remoteSha,
      });
    } catch {
      // ignore
    }
  }

  clearDismissedShareRemoteSha(scope: ShareLiveScope, storage: StorageLike = defaultStorage()): void {
    const key = this.shareScopeKey(scope);
    safeRemove(storage, LS.shareDismissedRemoteSha(key));
    this.audit('session', 'STALENESS_SHARE_REMOTE_SHA_CLEAR', 'Cleared dismissed share remote SHA marker', {
      repository: scope.repository,
      branch: scope.branch,
      graph: scope.graph,
      scopeKey: key,
      key: LS.shareDismissedRemoteSha(key),
    });
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
      this.audit('session', 'STALENESS_REMOTE_SHA_DISMISS', 'Dismissed remote SHA (won’t prompt again until remote changes)', {
        repository,
        branch,
        repoBranch,
        key: LS.dismissedRemoteSha(repoBranch),
        remoteSha,
      });
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
    this.audit('session', 'STALENESS_REMOTE_SHA_CLEAR', 'Cleared dismissed remote SHA marker', {
      repository,
      branch,
      repoBranch,
      key: LS.dismissedRemoteSha(repoBranch),
    });
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
        {
          repository,
          branch,
          localSha,
          remoteHeadSha,
          isRemoteAhead,
          planEngineVersion: NUDGING_PLAN_ENGINE_VERSION,
          storageKeyWritten: LS.lastRemoteCheckAtMs(`${repository}-${branch}`),
        }
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
        {
          repository,
          branch,
          graph,
          localSha,
          remoteHeadSha,
          isRemoteAhead,
          planEngineVersion: NUDGING_PLAN_ENGINE_VERSION,
          storageKeyWritten: LS.shareLastRemoteCheckAtMs(`${repository}-${branch}-${graph}`),
        }
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
    workspace?: WorkspaceScope,
    targetSliceDsl?: string
  ): Promise<RetrieveAllSlicesStalenessStatus> {
    const graphMarker = (graph as any)?.metadata?.last_retrieve_all_slices_success_at_ms;
    const hasGraphMarker = typeof graphMarker === 'number' && Number.isFinite(graphMarker) && graphMarker >= 0;

    // Fast path: a recent "last successful run" marker should suppress staleness nudges even if
    // per-parameter retrieved_at values are older (cached runs are still "fresh enough").
    if (hasGraphMarker && nowMs - graphMarker <= STALENESS_NUDGE_RETRIEVE_ALL_SLICES_AFTER_MS) {
      return {
        isStale: false,
        parameterCount: 0,
        staleParameterCount: 0,
        mostRecentRetrievedAtMs: graphMarker,
        lastSuccessfulRunAtMs: graphMarker,
      };
    }

    const targets = retrieveAllSlicesPlannerService.collectTargets(graph);
    const parameterTargets = targets.filter(t => t.type === 'parameter') as Array<Extract<typeof targets[number], { type: 'parameter' }>>;

    let mostRecentRetrievedAtMs: number | undefined;
    let staleCount = 0;
    let hasAnyRetrievedAt = false;

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
          // Ignore IDB failures here; fall back to treating as unknown (do not nudge).
          values = undefined;
        }
      }

      if (!Array.isArray(values) || values.length === 0) {
        // No values: unknown/never retrieved. Do NOT treat as stale.
        // Rationale: brand new graphs/files should not be nagged to retrieve immediately.
        continue;
      }

      // If a target slice DSL is provided (e.g. chart entity pinned DSL), compute freshness
      // against that slice only (do not mix other slices' retrieved_at).
      if (typeof targetSliceDsl === 'string' && targetSliceDsl.trim()) {
        try {
          values = isolateSlice(values as any[], targetSliceDsl.trim());
        } catch {
          // If we cannot isolate a slice deterministically (e.g. implicit uncontexted on contexted-only data),
          // treat this parameter as "unknown" for staleness (do not nag).
          continue;
        }
        if (!Array.isArray(values) || values.length === 0) continue;
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
        hasAnyRetrievedAt = true;
        if (mostRecentRetrievedAtMs === undefined || paramMostRecent > mostRecentRetrievedAtMs) {
          mostRecentRetrievedAtMs = paramMostRecent;
        }
        if (nowMs - paramMostRecent > STALENESS_NUDGE_RETRIEVE_ALL_SLICES_AFTER_MS) {
          staleCount++;
        }
      }
    }

    // If we couldn't find any per-parameter retrieved_at timestamps but we DO have a (stale) graph marker,
    // fall back to treating this as stale. This preserves the "don't nag on brand new graphs" behaviour
    // while still respecting the marker for graphs that have previously been retrieved.
    if (!hasAnyRetrievedAt && hasGraphMarker && parameterTargets.length > 0) {
      return {
        isStale: nowMs - graphMarker > STALENESS_NUDGE_RETRIEVE_ALL_SLICES_AFTER_MS,
        parameterCount: parameterTargets.length,
        staleParameterCount: parameterTargets.length,
        mostRecentRetrievedAtMs: graphMarker,
        lastSuccessfulRunAtMs: graphMarker,
      };
    }

    return {
      // Only nudge if we have at least one real retrieval timestamp to compare against.
      // If nothing has ever been retrieved, this is a brand-new/empty state, not "stale".
      isStale: hasAnyRetrievedAt && staleCount > 0 && parameterTargets.length > 0,
      parameterCount: parameterTargets.length,
      staleParameterCount: staleCount,
      mostRecentRetrievedAtMs,
      lastSuccessfulRunAtMs: hasGraphMarker ? graphMarker : undefined,
    };
  }

  /**
   * Compute a deterministic nudging plan from already-available signals.
   *
   * IMPORTANT (Phase 1 safety):
   * - This is PURE plan computation; it must not perform network calls or mutate storage.
   * - Signal gathering (remote checks, DB lookups) remains in existing call sites until Phase 2+.
   */
  computeNudgingPlanFromSignals(params: {
    nowMs: number;
    signals: NudgingSignals;
    entity: NudgingPlan['entity'];
    scope?: NudgingPlan['scope'];
  }): NudgingPlan {
    const { signals, entity, scope } = params;
    const remoteV = signals.remoteAppVersion;
    const localV = signals.localAppVersion;

    const remoteKnown = typeof remoteV === 'string' && remoteV.length > 0;
    const remoteNewer = remoteKnown ? isRemoteSemverNewer(remoteV!, localV) : false;
    const remoteOlder = remoteKnown ? isRemoteSemverOlder(remoteV!, localV) : false;

    const reload: NudgingStep = (() => {
      if (!remoteKnown) {
        return { key: 'reload', status: 'unknown', reason: 'Deployed client version not checked yet' };
      }
      if (remoteNewer) {
        return { key: 'reload', status: 'due', reason: `A newer client is deployed (you: ${localV}, deployed: ${remoteV})` };
      }
      if (remoteOlder) {
        return { key: 'reload', status: 'not_due', reason: `Deployed client is older than your client (staged rollout; you: ${localV}, deployed: ${remoteV})` };
      }
      return { key: 'reload', status: 'not_due', reason: 'Client is up to date' };
    })();

    const gitSignal = signals.git;
    const pull: NudgingStep = (() => {
      // Strict cascade: if update is due, downstream steps are blocked.
      if (reload.status === 'due') {
        return { key: 'git-pull', status: 'blocked', blockedBy: 'reload', reason: 'Blocked: update client first' };
      }
      if (!scope) {
        return { key: 'git-pull', status: 'unknown', reason: 'Repository scope not available' };
      }
      if (!gitSignal) {
        return { key: 'git-pull', status: 'unknown', reason: 'Remote git state not checked yet' };
      }
      if (gitSignal.isRemoteAhead) {
        return { key: 'git-pull', status: 'due', reason: 'Remote has newer commits; pull is recommended' };
      }
      return { key: 'git-pull', status: 'not_due', reason: 'Local matches remote' };
    })();

    const retrieveSignal = signals.retrieve;
    const retrieve: NudgingStep = (() => {
      // Strict cascade: if update is due, downstream steps are blocked.
      if (reload.status === 'due') {
        return { key: 'retrieve-all-slices', status: 'blocked', blockedBy: 'reload', reason: 'Blocked: update client first' };
      }
      if (pull.status === 'due') {
        return { key: 'retrieve-all-slices', status: 'blocked', blockedBy: 'git-pull', reason: 'Blocked: pull latest first' };
      }
      if (!retrieveSignal) {
        return { key: 'retrieve-all-slices', status: 'unknown', reason: 'Retrieve freshness not evaluated' };
      }
      if (!retrieveSignal.isStale) {
        return { key: 'retrieve-all-slices', status: 'not_due', reason: 'Retrieve is fresh (within cooloff window)' };
      }

      // Git unknown handling:
      // Default cascade is conservative, but our decision is to allow retrieve when git is unknown,
      // provided we clearly label it and ensure execution does not attempt any git operations.
      if (pull.status === 'unknown') {
        return {
          key: 'retrieve-all-slices',
          status: 'due',
          reason: 'Retrieve is stale; proceeding without pull because git state is unknown',
          retrieveWithoutPull: true,
        };
      }

      return { key: 'retrieve-all-slices', status: 'due', reason: 'Retrieve is stale (refresh recommended)' };
    })();

    const steps: NudgingPlan['steps'] = {
      reload,
      'git-pull': pull,
      'retrieve-all-slices': retrieve,
    };

    // Recommended defaults for interactive UI:
    // - Reload and pull may be pre-selected when due.
    // - Retrieve must NEVER be pre-selected (safety: avoid accidental thundering herd / surprise server load).
    const recommendedChecked: NudgingPlan['recommendedChecked'] = {
      reload: steps.reload.status === 'due',
      // Strict cascade: do not pre-select pull when blocked behind update.
      'git-pull': steps['git-pull'].status === 'due',
      'retrieve-all-slices': false,
    };

    return { entity, scope, steps, recommendedChecked };
  }

  /**
   * Execute user-selected staleness actions in a safe, deterministic order.
   *
   * IMPORTANT:
   * - This is orchestration only. It relies on passed-in callbacks for UI/service integration.
   * - Retrieve is never auto-run by this method unless the user explicitly selected it.
   */
  async runSelectedStalenessActions(opts: RunSelectedStalenessActionsOptions): Promise<void> {
    const {
      selected,
      nowMs,
      storage,
      localAppVersion,
      repository,
      branch,
      shareGraph,
      graphFileId,
      isShareLive,
      automaticMode,
      pullAll,
      refreshLiveShareToLatest,
      requestRetrieveAllSlices,
      executeRetrieveAllSlicesHeadless,
      openSessionLogTab,
      getGraphData,
      reloadPage,
      notify,
    } = opts;

    const wantsReload = selected.has('reload');
    const wantsPull = selected.has('git-pull');
    const wantsRetrieve = selected.has('retrieve-all-slices');

    // Strict cascade: if an update is due, do NOT run pull/retrieve on an out-of-date client.
    // The only safe action is reload.
    const updateDue = this.isRemoteAppVersionNewerThanLocal(localAppVersion, storage);
    if (updateDue) {
      if (wantsPull || wantsRetrieve) {
        sessionLogService.warning(
          'session',
          'STALENESS_BLOCKED_BY_UPDATE',
          'Blocked: update required before running pull/retrieve',
          undefined,
          {
            repository,
            branch,
            fileId: graphFileId,
            wantsPull,
            wantsRetrieve,
            planEngineVersion: NUDGING_PLAN_ENGINE_VERSION,
          }
        );
        notify('error', 'Update required: reload before pulling/retrieving');
      }
      if (wantsReload) {
        reloadPage();
      }
      return;
    }

    // SAFETY POLICY:
    // - We do NOT persist pending plans across refresh.
    // - If reload is selected alongside other actions, run those actions NOW (explicit user intent),
    //   then reload at the end. Nothing is carried across refresh.
    if (wantsReload && (wantsPull || wantsRetrieve)) {
      sessionLogService.info(
        'session',
        'STALENESS_RUN_THEN_RELOAD',
        'Reload selected alongside other actions; running selected actions now, then reloading (nothing will run automatically after refresh)',
        undefined,
        {
          repository,
          branch,
          fileId: graphFileId,
          wantsPull,
          wantsRetrieve,
          planEngineVersion: NUDGING_PLAN_ENGINE_VERSION,
        }
      );
    }

    if (wantsPull) {
      if (isShareLive && repository && shareGraph) {
        const res = await refreshLiveShareToLatest?.();
        if (!res?.success) {
          notify('error', res?.error || 'Live refresh failed');
        } else {
          notify('success', 'Updated to latest');
          this.clearDismissedShareRemoteSha({ repository, branch, graph: shareGraph }, storage);
        }
      } else {
        await pullAll();
        // Clear dismissed SHA after successful pull so future changes are detected
        if (repository) {
          this.clearDismissedRemoteSha(repository, branch, storage);
        }
      }
    }

    if (wantsRetrieve) {
      const mustCompleteBeforeReload = wantsReload;

      // If pull was also selected, re-check staleness after pull based on repo-backed state.
      if (wantsPull && graphFileId) {
        const graphAfterPull = getGraphData();
        if (!graphAfterPull) return;

        const status = await this.getRetrieveAllSlicesStalenessStatus(
          graphAfterPull,
          nowMs,
          repository ? { repository, branch } : undefined
        );

        if (!status.isStale) {
          sessionLogService.info(
            'data-fetch',
            'RETRIEVE_ALL_SKIPPED_AFTER_PULL',
            'Retrieve All skipped: pull brought fresh retrieval state (within cooloff window)',
            undefined,
            {
              fileId: graphFileId,
              repository,
              branch,
              mostRecentRetrievedAtMs: status.mostRecentRetrievedAtMs,
              parameterCount: status.parameterCount,
              staleParameterCount: status.staleParameterCount,
              planEngineVersion: NUDGING_PLAN_ENGINE_VERSION,
            }
          );
        } else if (automaticMode || mustCompleteBeforeReload) {
          openSessionLogTab();
          await executeRetrieveAllSlicesHeadless({
            toastId: `retrieve-all-automatic:${graphFileId}`,
            toastLabel: 'Retrieve All (automatic)',
          });
        } else {
          requestRetrieveAllSlices();
        }
      } else if (automaticMode || mustCompleteBeforeReload) {
        if (!graphFileId) return;
        openSessionLogTab();
        await executeRetrieveAllSlicesHeadless({
          toastId: `retrieve-all-automatic:${graphFileId}`,
          toastLabel: 'Retrieve All (automatic)',
        });
      } else {
        requestRetrieveAllSlices();
      }
    }

    if (wantsReload) {
      reloadPage();
    }
  }

  /**
   * Auto-pull orchestration invoked by the staleness countdown expiry (git pull ONLY; no retrieve).
   * This is currently used for dashboard/unattended flows.
   */
  async handleStalenessAutoPull(opts: HandleStalenessAutoPullOptions): Promise<void> {
    const {
      nowMs,
      storage,
      repository,
      branch,
      shareGraph,
      isShareLive,
      isDashboardMode,
      pullAll,
      pullLatestRemoteWins,
      refreshLiveShareToLatest,
      notify,
    } = opts;

    sessionLogService.info(
      'session',
      'STALENESS_AUTO_PULL',
      isShareLive ? 'Auto-refreshing live share (countdown expired)' : 'Auto-pulling from repository (countdown expired)',
      undefined,
      { repository, branch, graph: shareGraph, nowMs, planEngineVersion: NUDGING_PLAN_ENGINE_VERSION }
    );

    if (isShareLive && repository && shareGraph) {
      const res = await refreshLiveShareToLatest?.();
      if (!res?.success) {
        notify('error', res?.error || 'Live refresh failed');
        return;
      }
      notify('success', 'Updated to latest');
      this.clearDismissedShareRemoteSha({ repository, branch, graph: shareGraph }, storage);
      return;
    }

    if (isDashboardMode && repository && pullLatestRemoteWins) {
      // Unattended terminals prefer "remote wins" to avoid blocking on conflicts.
      await pullLatestRemoteWins();
    } else {
      await pullAll();
    }

    // Clear dismissed SHA after successful pull (so future changes are detected)
    if (repository) {
      this.clearDismissedRemoteSha(repository, branch, storage);
    }
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


