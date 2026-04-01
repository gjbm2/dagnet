/**
 * Staleness Nudge Jobs
 *
 * Registers version-check, git-remote-check, auto-pull, and retrieve-nudge
 * as jobSchedulerService jobs. This module bridges between the React context
 * (repo, branch, share mode) and the service-level scheduler.
 *
 * The hook (useStalenessNudges) calls `updateNudgeContext()` on every render
 * to keep the context fresh. The job runFns read from this context.
 */

import { jobSchedulerService } from './jobSchedulerService';
import { stalenessNudgeService } from './stalenessNudgeService';
import { operationRegistryService } from './operationRegistryService';
import { repositoryOperationsService } from './repositoryOperationsService';
import { sessionLogService } from './sessionLogService';
import { APP_VERSION } from '../version';
import {
  STALENESS_NUDGE_APP_VERSION_CHECK_INTERVAL_MS,
  STALENESS_NUDGE_REMOTE_CHECK_INTERVAL_MS,
  STALENESS_NUDGE_DASHBOARD_REMOTE_CHECK_INTERVAL_MS,
  STALENESS_NUDGE_MIN_REPEAT_MS,
} from '../constants/staleness';

// ---------------------------------------------------------------------------
// Nudge context — written by the hook, read by job runFns
// ---------------------------------------------------------------------------

export interface NudgeContext {
  repository?: string;
  branch: string;
  isShareLive: boolean;
  shareGraph?: string;
  isDashboardMode: boolean;
  navigatorIsLoading: boolean;
  retrieveTargetGraphFileId?: string;
  activeFileType?: string;
  activeChartEffectiveDsl?: string;
  /** True when ?nonudge, static share mode, or ?retrieveall suppresses nudges. */
  suppressed: boolean;
  /** Callback to fire non-blocking pull (wired to usePullAll in the hook). */
  onPullNeeded?: (opts: {
    repository: string;
    branch: string;
    detectedRemoteSha: string;
    retrieveDue: boolean;
  }) => void;
}

const nudgeCtx: NudgeContext = {
  branch: 'main',
  isShareLive: false,
  isDashboardMode: false,
  navigatorIsLoading: false,
  suppressed: false,
};

/** Called by useStalenessNudges on every render to keep context fresh. */
export function updateNudgeContext(ctx: Partial<NudgeContext>): void {
  Object.assign(nudgeCtx, ctx);
}

/** Read current context (for job runFns). */
export function getNudgeContext(): Readonly<NudgeContext> {
  return nudgeCtx;
}

// ---------------------------------------------------------------------------
// Job registration (called once from the hook)
// ---------------------------------------------------------------------------

let jobsRegistered = false;

export function registerStalenessNudgeJobs(): void {
  if (jobsRegistered) return;
  jobsRegistered = true;

  // ---- version-check: periodic(10min), triggerOnFocus, boot-gated --------
  jobSchedulerService.registerJob({
    id: 'version-check',
    schedule: {
      type: 'periodic',
      intervalMs: STALENESS_NUDGE_APP_VERSION_CHECK_INTERVAL_MS,
      triggerOnFocus: true,
    },
    bootGated: true,
    presentation: 'banner:app-update',
    rateLimitMs: STALENESS_NUDGE_MIN_REPEAT_MS,
    runFn: async (ctx) => {
      const nc = getNudgeContext();
      if (nc.suppressed) return;
      if (typeof document !== 'undefined' && document.hidden) return;

      const now = Date.now();
      const storage = window.localStorage;

      // Record page load baseline (once).
      if (!storage.getItem('dagnet:staleness:lastPageLoadAtMs')) {
        stalenessNudgeService.recordPageLoad(now, storage);
      }

      const reloadSnoozed = stalenessNudgeService.isSnoozed('reload', undefined, now, storage);

      const updateSignal = await stalenessNudgeService.collectUpdateSignal({
        nowMs: now,
        localAppVersion: APP_VERSION,
        storage,
        reloadSnoozed,
      });

      if (!updateSignal.isOutdated) return;

      // Dashboard mode: auto-reload.
      if (nc.isDashboardMode) {
        const didReload = stalenessNudgeService.maybeAutoReloadForUpdate(APP_VERSION, now, storage);
        if (didReload) return;
      }

      // Interactive mode: show banner.
      if (updateSignal.reloadDue) {
        stalenessNudgeService.markPrompted('reload', now, storage);

        // Check if our banner is suppressed by a running automation.
        if (ctx.scheduler.isJobSuppressed('version-check')) return;

        const versionDetail = updateSignal.remoteAppVersion
          ? `Current: ${APP_VERSION} → Available: ${updateSignal.remoteAppVersion}`
          : undefined;

        ctx.showBanner({
          label: 'New version available — reload to update',
          detail: versionDetail,
          actionLabel: 'Reload now',
          onAction: () => window.location.reload(),
          actionTitle: 'Reload to pick up the latest version',
        });
      }
    },
  });

  // ---- git-remote-check: periodic(10min), triggerOnFocus, boot-gated -----
  // Timer fires every 10 min (dashboard cadence). In interactive mode,
  // shouldCheckRemoteHead still gates the actual network call at 30 min.
  jobSchedulerService.registerJob({
    id: 'git-remote-check',
    schedule: {
      type: 'periodic',
      intervalMs: STALENESS_NUDGE_DASHBOARD_REMOTE_CHECK_INTERVAL_MS,
      triggerOnFocus: true,
    },
    bootGated: true,
    presentation: 'silent',
    rateLimitMs: STALENESS_NUDGE_MIN_REPEAT_MS,
    runFn: async (ctx) => {
      const nc = getNudgeContext();
      if (nc.suppressed) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!nc.repository) return;
      if (!nc.isShareLive && nc.navigatorIsLoading) return;

      const now = Date.now();
      const storage = window.localStorage;

      const gitCollected = await stalenessNudgeService.collectGitSignal({
        nowMs: now,
        storage,
        repository: nc.repository,
        branch: nc.branch,
        isShareLive: nc.isShareLive,
        shareGraph: nc.shareGraph,
        remoteCheckIntervalMs: nc.isDashboardMode ? STALENESS_NUDGE_DASHBOARD_REMOTE_CHECK_INTERVAL_MS : undefined,
      });

      const retrieveSignalCollected = await stalenessNudgeService.collectRetrieveSignal({
        nowMs: now,
        storage,
        retrieveTargetGraphFileId: nc.retrieveTargetGraphFileId,
        repository: nc.repository,
        branch: nc.branch,
        targetSliceDsl: nc.activeFileType === 'chart' ? nc.activeChartEffectiveDsl : undefined,
      });

      const gitPullDue = gitCollected.gitPullDue;
      const detectedRemoteSha = gitCollected.detectedRemoteSha;
      const retrieveDue = retrieveSignalCollected.retrieveDue;

      if (!gitPullDue && !retrieveDue) return;

      if (gitPullDue) stalenessNudgeService.markPrompted('git-pull', now, storage);
      if (retrieveDue) stalenessNudgeService.markPrompted('retrieve-all-slices', now, storage);

      // Trigger auto-pull if git is ahead.
      if (gitPullDue && detectedRemoteSha && nc.repository) {
        nc.onPullNeeded?.({
          repository: nc.repository,
          branch: nc.branch,
          detectedRemoteSha,
          retrieveDue,
        });
      }

      // Retrieve due standalone (no pull cascading into it) → show nudge.
      if (retrieveDue && !gitPullDue) {
        ctx.scheduler.run('retrieve-nudge');
      }
    },
  });

  // ---- retrieve-nudge: reactive, boot-gated, transient operation ---------
  // Note: Uses 'retrieve-stale' as the operation ID for backward compatibility
  // with existing UI and test expectations.
  jobSchedulerService.registerJob({
    id: 'retrieve-nudge',
    schedule: { type: 'reactive' },
    bootGated: true,
    presentation: 'silent', // We handle the operation manually for custom ID.
    runFn: async () => {
      operationRegistryService.register({
        id: 'retrieve-stale',
        kind: 'staleness-nudge',
        label: 'Data may be stale \u2014 use Data \u203a Retrieve All Slices to refresh',
        status: 'pending',
      });
      // Auto-dismiss after 8 seconds.
      await new Promise<void>(resolve => setTimeout(resolve, 8_000));
      operationRegistryService.complete('retrieve-stale', 'complete', 'Dismissed');
    },
  });
}

/** Reset for tests. */
export function _resetStalenessNudgeJobs(): void {
  jobsRegistered = false;
  Object.assign(nudgeCtx, {
    repository: undefined,
    branch: 'main',
    isShareLive: false,
    shareGraph: undefined,
    isDashboardMode: false,
    navigatorIsLoading: false,
    retrieveTargetGraphFileId: undefined,
    activeFileType: undefined,
    activeChartEffectiveDsl: undefined,
    suppressed: false,
    onPullNeeded: undefined,
  });
}
