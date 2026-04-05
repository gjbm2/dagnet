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

      // Retry once if commit flow detects remote-ahead and requests an additional pull.
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (shouldAbort?.()) {
          sessionLogService.endOperation(logOpId, 'warning', 'Daily automation aborted before commit');
          return;
        }

        const committable = await repositoryOperationsService.getCommittableFiles(repository, branch);
        if (committable.length === 0) {
          sessionLogService.addChild(logOpId, 'info', 'COMMIT_SKIPPED', 'No committable files (nothing changed)');
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
          sessionLogService.addChild(logOpId, 'success', 'COMMIT_COMPLETE', `Committed ${committable.length} file(s)`);
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('please commit again') && attempt < 2) {
            sessionLogService.addChild(logOpId, 'warning', 'COMMIT_RETRY', 'Commit requested retry after pull; retrying');
            continue;
          }
          throw e;
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
