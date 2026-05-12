/**
 * Per-Graph Automation Service
 *
 * Runs the per-graph workflow: version check → retrieve → horizons → commit.
 * Called by dailyAutomationJob.ts once per target graph.
 *
 * The upfront pull is handled by the job — this service does NOT pull.
 * Cross-tab locking is handled by the scheduler — this service does NOT lock.
 */

import type { GraphData } from '../types';
import { formatDateUK } from '../lib/dateFormat';
import { sessionLogService } from './sessionLogService';
import { repositoryOperationsService } from './repositoryOperationsService';
import { executeRetrieveAllSlicesWithProgressToast } from './retrieveAllSlicesService';
import { stalenessNudgeService } from './stalenessNudgeService';
import { APP_VERSION } from '../version';
import { lagHorizonsService } from './lagHorizonsService';

export interface DailyRetrieveAllAutomationOptions {
  repository: string;
  branch: string;
  graphFileId: string;
  getGraph: () => GraphData | null;
  setGraph: (g: GraphData | null) => void;
  shouldAbort?: () => boolean;
}

function inferGraphName(graphFileId: string): string {
  if (graphFileId.startsWith('graph-')) return graphFileId.slice('graph-'.length);
  return graphFileId;
}

class DailyRetrieveAllAutomationService {
  private static instance: DailyRetrieveAllAutomationService;

  static getInstance(): DailyRetrieveAllAutomationService {
    if (!DailyRetrieveAllAutomationService.instance) {
      DailyRetrieveAllAutomationService.instance = new DailyRetrieveAllAutomationService();
    }
    return DailyRetrieveAllAutomationService.instance;
  }

  async run(options: DailyRetrieveAllAutomationOptions): Promise<void> {
    const { repository, branch, graphFileId, getGraph, setGraph, shouldAbort } = options;

    const graphName = inferGraphName(graphFileId);
    const logOpId = sessionLogService.startOperation(
      'info',
      'session',
      'DAILY_RETRIEVE_ALL',
      `Daily automation: retrieve all → commit (${repository}/${branch}, graph: ${graphName})`,
      { repository, branch, fileId: graphFileId }
    );

    try {
      if (shouldAbort?.()) {
        sessionLogService.endOperation(logOpId, 'warning', 'Daily automation aborted before start');
        return;
      }

      // Automation safety: never run retrieve/commit on an out-of-date client.
      // If a newer client is deployed, log and abort so the operator can refresh the page.
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          const storage = window.localStorage;
          await stalenessNudgeService.refreshRemoteAppVersionIfDue(Date.now(), storage);
          if (stalenessNudgeService.isRemoteAppVersionNewerThanLocal(APP_VERSION, storage)) {
            const remoteV = stalenessNudgeService.getCachedRemoteAppVersion(storage);
            sessionLogService.addChild(
              logOpId,
              'warning',
              'UPDATE_REQUIRED_ABORT',
              `Daily automation aborted: update required (you: ${APP_VERSION}, deployed: ${remoteV ?? 'unknown'})`
            );
            sessionLogService.endOperation(logOpId, 'warning', 'Daily automation aborted: update required');
            return;
          }
        }
      } catch {
        // Best-effort only; if version check fails (offline), proceed.
      }

      if (shouldAbort?.()) {
        sessionLogService.endOperation(logOpId, 'warning', 'Daily automation aborted after version check');
        return;
      }

      // Retrieve all slices (headless).
      sessionLogService.addChild(logOpId, 'info', 'STEP_RETRIEVE', 'Running Retrieve All Slices (headless)');
      const retrieveResult = await executeRetrieveAllSlicesWithProgressToast({
        getGraph,
        setGraph,
        shouldAbort,
        toastId: `retrieve-all-automation:${graphFileId}`,
        toastLabel: `Retrieve All (${graphName})`,
        checkDbCoverageFirst: true,
        workspace: { repository, branch },
      });
      sessionLogService.addChild(
        logOpId,
        retrieveResult.totalErrors > 0 ? 'warning' : 'success',
        'RETRIEVE_COMPLETE',
        `Retrieve All complete: ${retrieveResult.totalSuccess} succeeded, ${retrieveResult.totalErrors} failed`,
        undefined,
        retrieveResult as any
      );

      // Recompute global horizons (best-effort).
      try {
        await lagHorizonsService.recomputeHorizons({
          mode: 'global',
          getGraph,
          setGraph,
          reason: 'daily-retrieve-all-automation',
        });
      } catch {
        sessionLogService.addChild(logOpId, 'warning', 'HORIZONS_GLOBAL_RECOMPUTE_FAILED', 'Global horizons recompute failed (best-effort)');
      }

      if (shouldAbort?.()) {
        sessionLogService.endOperation(logOpId, 'warning', 'Daily automation aborted after retrieve');
        return;
      }

      // Commit all changes.
      sessionLogService.addChild(logOpId, 'info', 'STEP_COMMIT', 'Committing all changes');

      const commitMessage = `Daily data refresh (${graphName}) - ${formatDateUK(new Date())}`;

      // Commit MUST succeed at end of retrieve. Pull-then-commit pattern: every
      // iteration starts with a fresh pull, then commits. If commit races mid-
      // flight ("Update is not a fast forward" from updateRef step 6 in
      // gitService.commitAndPushFiles), the next iteration pulls again — which
      // gives commitFiles a fresh remote-head SHA to use as the new commit's
      // parent. Without rebuilding on the new head, the commit's parent stays
      // stale and the push fails forever.
      const MAX_COMMIT_ATTEMPTS = 20;
      const isRemoteAhead = (msg: string): boolean => {
        const lower = msg.toLowerCase();
        return lower.includes('please commit again')
            || lower.includes('not a fast forward')
            || lower.includes('fast-forward');
      };

      for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
        if (shouldAbort?.()) {
          sessionLogService.endOperation(logOpId, 'warning', 'Daily automation aborted before commit');
          return;
        }

        // ── Step 1: PULL ──
        // Always pull first. Idempotent if remote is already at our state.
        // After this, workspace.commitSHA matches the remote head, so
        // commitFiles' internal pre-check is a no-op and the new commit will
        // be built with the correct parent SHA.
        try {
          await repositoryOperationsService.pullLatestRemoteWins(repository, branch);
        } catch (pullErr) {
          const pullMsg = pullErr instanceof Error ? pullErr.message : String(pullErr);
          if (attempt === 1) {
            // First-attempt pull failure is a real problem (auth, network, etc).
            sessionLogService.endOperation(logOpId, 'error',
              `Pull before commit failed: ${pullMsg}`);
            throw pullErr;
          }
          // Mid-retry pull failure: tolerate and let the next commit attempt
          // either succeed or fail again.
          sessionLogService.addChild(logOpId, 'warning', 'COMMIT_RETRY_PULL_FAILED',
            `Pull before retry attempt ${attempt} failed: ${pullMsg}; will try commit anyway`);
        }

        // ── Step 2: COMMIT ──
        const committable = await repositoryOperationsService.getCommittableFiles(repository, branch);
        if (committable.length === 0) {
          sessionLogService.addChild(logOpId, 'info', 'COMMIT_SKIPPED',
            attempt === 1
              ? 'No committable files (nothing changed)'
              : `No committable files after attempt ${attempt} pull (changes may have been merged remotely)`);
          break;
        }

        try {
          await repositoryOperationsService.commitFiles(
            committable,
            commitMessage,
            branch,
            repository,
            async () => 'primary', // Always pull first in headless runs
            async () => {
              sessionLogService.addChild(logOpId, 'warning', 'REMOTE_AHEAD_PULL', 'Remote ahead during commit - pulling and retrying');
              await repositoryOperationsService.pullLatestRemoteWins(repository, branch);
            }
          );
          sessionLogService.addChild(logOpId, 'success', 'COMMIT_COMPLETE',
            `Committed ${committable.length} file(s)${attempt > 1 ? ` on attempt ${attempt}` : ''}`);
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);

          if (!isRemoteAhead(msg)) {
            // Real error: auth, permissions, validation, network. Bubble up.
            throw e;
          }

          if (attempt >= MAX_COMMIT_ATTEMPTS) {
            sessionLogService.addChild(logOpId, 'error', 'COMMIT_RETRY_EXHAUSTED',
              `Commit blocked by ${MAX_COMMIT_ATTEMPTS} consecutive remote-ahead races; giving up.`, msg);
            throw e;
          }

          // Race during the commit dance. The next iteration's pull will catch
          // us up; commitFiles will then rebuild the commit with the new parent.
          // Exponential backoff with jitter — jitter desynchronises us from any
          // concurrent commit cycle (e.g. the 10-min log-commit loop).
          const backoffBase = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
          const backoffMs = backoffBase + Math.floor(Math.random() * 1000);
          sessionLogService.addChild(logOpId, 'warning', 'COMMIT_RETRY',
            `Commit attempt ${attempt} blocked by remote-ahead; will pull and rebuild commit in ${Math.round(backoffMs / 1000)}s`,
            msg);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }

      sessionLogService.endOperation(logOpId, 'success', 'Daily automation complete');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sessionLogService.endOperation(logOpId, 'error', `Daily automation failed: ${msg}`);
      throw e;
    }
  }
}

export const dailyRetrieveAllAutomationService = DailyRetrieveAllAutomationService.getInstance();
