import type { GraphData } from '../types';
import { formatDateUK } from '../lib/dateFormat';
import { sessionLogService } from './sessionLogService';
import { repositoryOperationsService } from './repositoryOperationsService';
import { retrieveAllSlicesService } from './retrieveAllSlicesService';

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

  private async withCrossTabLock<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const nav: any = (typeof navigator !== 'undefined') ? (navigator as any) : null;
      if (nav?.locks?.request) {
        // Web Locks API serialises across tabs/windows for the same origin.
        return await nav.locks.request('dagnet:daily-retrieveall', { mode: 'exclusive' }, async () => {
          return await fn();
        });
      }
    } catch {
      // Best-effort only; fall back to in-tab execution.
    }
    return await fn();
  }

  async run(options: DailyRetrieveAllAutomationOptions): Promise<void> {
    return this.withCrossTabLock(() => this.runInternal(options));
  }

  private async runInternal(options: DailyRetrieveAllAutomationOptions): Promise<void> {
    const { repository, branch, graphFileId, getGraph, setGraph, shouldAbort } = options;

    const graphName = inferGraphName(graphFileId);
    const logOpId = sessionLogService.startOperation(
      'info',
      'session',
      'DAILY_RETRIEVE_ALL',
      `Daily automation: pull → retrieve all → commit (${repository}/${branch}, graph: ${graphName})`,
      { repository, branch, fileId: graphFileId }
    );

    try {
      if (shouldAbort?.()) {
        sessionLogService.endOperation(logOpId, 'warning', 'Daily automation aborted before start');
        return;
      }

      sessionLogService.addChild(logOpId, 'info', 'STEP_PULL', 'Pulling latest (remote wins)');
      const pullResult = await repositoryOperationsService.pullLatestRemoteWins(repository, branch);
      if ((pullResult.conflictsResolved ?? 0) > 0) {
        sessionLogService.addChild(
          logOpId,
          'warning',
          'PULL_CONFLICTS_RESOLVED',
          `Resolved ${pullResult.conflictsResolved} conflict(s) by accepting remote`
        );
      }

      if (shouldAbort?.()) {
        sessionLogService.endOperation(logOpId, 'warning', 'Daily automation aborted after pull');
        return;
      }

      sessionLogService.addChild(logOpId, 'info', 'STEP_RETRIEVE', 'Running Retrieve All Slices (headless)');
      const retrieveResult = await retrieveAllSlicesService.execute({
        getGraph,
        setGraph,
        shouldAbort,
      });
      sessionLogService.addChild(
        logOpId,
        retrieveResult.totalErrors > 0 ? 'warning' : 'success',
        'RETRIEVE_COMPLETE',
        `Retrieve All complete: ${retrieveResult.totalSuccess} succeeded, ${retrieveResult.totalErrors} failed`,
        undefined,
        retrieveResult as any
      );

      if (shouldAbort?.()) {
        sessionLogService.endOperation(logOpId, 'warning', 'Daily automation aborted after retrieve');
        return;
      }

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


