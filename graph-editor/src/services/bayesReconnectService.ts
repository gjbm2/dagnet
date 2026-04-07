/**
 * Bayes Reconnect Service (doc 28 §4.3, §4.5, §8.6)
 *
 * Handles reconnection to in-flight Bayes jobs after browser close/reopen.
 * Provides the reconcileFn for the scheduler and resume-polling for
 * still-running jobs. No React dependency — pure service.
 *
 * The reconcileFn does NOT apply patches itself (§8.3: fileRegistry may
 * not be ready at boot). It only determines status and triggers pullAfter
 * if a patch file exists. Patch application happens in the on-pull scanner
 * (scanForPendingPatches in bayesPatchService.ts).
 */

import {
  fetchBayesConfig,
  encryptCallbackToken,
  submitBayesFit,
  pollBayesStatus,
  pollUntilDone,
} from './bayesService';
import { applyPatchAndCascade } from './bayesPatchService';
import { sessionLogService } from './sessionLogService';
import { operationRegistryService } from './operationRegistryService';
import { jobSchedulerService } from './jobSchedulerService';
import { fileRegistry } from '../contexts/TabContext';
import { credentialsManager } from '../lib/credentials';
import type { PersistedJobRecord, ReconcileResult } from './jobSchedulerService';

console.log('[bayesReconnectService] Module loaded');

// ── Persisted job params shape (doc 28 §4.2) ─────────────────────────────

export interface BayesFitJobParams {
  modalCallId?: string;         // Set in phase 2 of two-phase persist (after submit returns)
  computeMode: 'local' | 'modal';
  graphId: string;
  graphFilePath: string;
  repo: string;
  branch: string;
  patchPath?: string;           // e.g. '_bayes/patch-{jobId}.json' — set after submit
  statusUrl?: string;           // Override for local dev
  webhookUrl?: string;          // For diagnostic logging
  submittedAtIso: string;       // ISO timestamp for age checks
}

// ── Age thresholds (doc 28 §8.12) ────────────────────────────────────────

/** Grace period: if status probe fails and no patch, assume still running if < 60 min old. */
const PROBE_GRACE_MINUTES = 60;

/** IDB hygiene: any job older than 24h is definitively dead. */
const STALE_CUTOFF_HOURS = 24;

// ── reconcileFn (doc 28 §4.3) ────────────────────────────────────────────
//
// Called on boot for each persisted bayes-fit job in submitted/running state.
// Three-step probe:
//   Step 1: probe Modal/local status
//   Step 2: check for patch file in git (via pullAfter)
//   Step 3: surface outcome
//
// Does NOT apply patches — that's the on-pull scanner's job (§8.3).

export async function reconcileBayesFitJob(record: PersistedJobRecord): Promise<ReconcileResult> {
  const params = record.params as BayesFitJobParams | undefined;

  if (!params) {
    return { status: 'error', error: 'No params on persisted job record' };
  }

  const ageMs = Date.now() - record.submittedAtMs;
  const ageHours = ageMs / (60 * 60 * 1000);

  // IDB hygiene: definitively dead after 24h
  if (ageHours > STALE_CUTOFF_HOURS) {
    sessionLogService.warning('bayes', 'BAYES_RECONCILE_STALE',
      `Job ${record.jobId} is ${ageHours.toFixed(1)}h old — marking as stale`);
    return { status: 'error', error: `Job lost: ${ageHours.toFixed(1)}h old, exceeds ${STALE_CUTOFF_HOURS}h threshold` };
  }

  // Step 1: probe Modal/local status
  let probeResult: { status: string; result?: any; error?: string } | null = null;

  if (params.modalCallId) {
    try {
      probeResult = await pollBayesStatus(params.modalCallId, params.statusUrl);
    } catch (err: any) {
      // Probe failed — network error, 404 (local server restarted), etc.
      sessionLogService.info('bayes', 'BAYES_RECONCILE_PROBE_FAIL',
        `Status probe failed for ${record.jobId}: ${err.message}`);
      probeResult = null;
    }
  } else {
    // No modalCallId — two-phase persist incomplete (§8.1).
    // Browser crashed between submit and the params update. Skip probe.
    sessionLogService.info('bayes', 'BAYES_RECONCILE_NO_CALL_ID',
      `Job ${record.jobId} has no modalCallId — skipping status probe`);
  }

  // Step 2: interpret probe result

  if (probeResult?.status === 'complete') {
    // Job completed — trigger a pull to get the patch file
    sessionLogService.success('bayes', 'BAYES_RECONCILE_COMPLETE',
      `Job ${record.jobId} completed on remote — pulling to get patch`);
    return {
      status: 'complete',
      result: probeResult.result,
      pullAfter: { repo: params.repo, branch: params.branch },
      label: `Bayes fit completed (reconnected) — pulling results`,
    };
  }

  if (probeResult?.status === 'running') {
    // Still running — resume polling (§4.5 Option A)
    sessionLogService.info('bayes', 'BAYES_RECONCILE_RUNNING',
      `Job ${record.jobId} still running — resuming polling`);
    // Fire-and-forget: resume polling in background
    resumePolling(record.jobId, params);
    return { status: 'running' };
  }

  if (probeResult?.status === 'failed') {
    return {
      status: 'error',
      error: `Remote job failed: ${probeResult.error ?? 'unknown error'}`,
      label: `Bayes fit failed (reconnected)`,
    };
  }

  // Probe returned null (failed) or unexpected status.
  // Optimistic fallback: trigger a pull — the patch may be in git.
  const ageMinutes = ageMs / (60 * 1000);

  if (ageMinutes < PROBE_GRACE_MINUTES) {
    // Young job, probe failed — assume still running (transient probe flakiness)
    sessionLogService.info('bayes', 'BAYES_RECONCILE_GRACE',
      `Job ${record.jobId} is ${ageMinutes.toFixed(0)}min old, probe failed — assuming still running`);
    return { status: 'running' };
  }

  // Older than grace period, probe failed — trigger pull optimistically.
  // The on-pull scanner will find the patch if it exists.
  sessionLogService.info('bayes', 'BAYES_RECONCILE_OPTIMISTIC_PULL',
    `Job ${record.jobId} is ${ageMinutes.toFixed(0)}min old, probe failed — pulling optimistically`);
  return {
    status: 'complete',
    pullAfter: { repo: params.repo, branch: params.branch },
    label: `Bayes fit — checking for results (reconnected)`,
  };
}

// ── Resume polling (doc 28 §4.5, §8.6) ───────────────────────────────────
//
// Service-level handler: calls pollUntilDone directly, updates
// operationRegistryService for toast display. No React dependency.

async function resumePolling(jobInstanceId: string, params: BayesFitJobParams): Promise<void> {
  if (!params.modalCallId) return;

  const opId = `bayes-reconnect:${jobInstanceId}`;
  operationRegistryService.register({
    id: opId,
    kind: 'bayes-fit',
    label: `Bayes fit resuming (${params.graphId})…`,
  });

  try {
    const finalStatus = await pollUntilDone(
      params.modalCallId,
      (status) => {
        const pct = (status as any)?.progress;
        if (pct != null) {
          operationRegistryService.setProgress(opId, { current: Math.round(pct * 100), total: 100 });
        }
        operationRegistryService.setLabel(opId, `Bayes fit running (${params.graphId})…`);
      },
      5_000,       // poll interval: 5s
      30 * 60 * 1000, // timeout: 30min (longer than interactive, per doc 28 F2)
      params.statusUrl,
    );

    if (finalStatus.status === 'complete') {
      // Trigger a pull to get the patch, then the on-pull scanner applies it
      operationRegistryService.setLabel(opId, `Bayes fit complete — pulling results`);

      const release = await jobSchedulerService.acquirePullLock(params.repo, params.branch);
      try {
        const { repositoryOperationsService } = await import('./repositoryOperationsService');
        await repositoryOperationsService.pullLatest(params.repo, params.branch);
      } finally {
        release();
      }

      operationRegistryService.complete(opId, 'complete');

      // Update the persisted job record
      const { db } = await import('../db/appDatabase');
      await db.schedulerJobs.update(jobInstanceId, {
        status: 'complete',
        lastUpdatedAtMs: Date.now(),
        result: finalStatus.result,
      });
    } else {
      operationRegistryService.complete(opId, 'error', finalStatus.error ?? 'Job did not complete');

      const { db } = await import('../db/appDatabase');
      await db.schedulerJobs.update(jobInstanceId, {
        status: 'error',
        lastUpdatedAtMs: Date.now(),
        error: finalStatus.error ?? `Status: ${finalStatus.status}`,
      });
    }

    sessionLogService.info('bayes', 'BAYES_RECONNECT_POLL_DONE',
      `Resume polling for ${jobInstanceId}: ${finalStatus.status}`);
  } catch (err: any) {
    operationRegistryService.complete(opId, 'error', err.message);
    sessionLogService.error('bayes', 'BAYES_RECONNECT_POLL_ERROR',
      `Resume polling failed for ${jobInstanceId}: ${err.message}`);
  }
}

// ── Job registration (doc 28 §4.1) ───────────────────────────────────────

let registered = false;

/**
 * Register the bayes-fit job definition with the scheduler.
 * Call once during app initialisation.
 */
export function registerBayesFitJob(): void {
  if (registered) return;
  registered = true;

  jobSchedulerService.registerJob({
    id: 'bayes-fit',
    schedule: { type: 'reactive' },
    persistent: true,
    reconcileFn: reconcileBayesFitJob,
    presentation: 'silent',
    operationKind: 'bayes-fit',
    operationLabel: 'Bayes fit',
    concurrency: { mode: 'singleton', onDuplicate: 'skip' },
    runFn: async (_ctx) => {
      // The runFn is a no-op — job execution happens in useBayesTrigger
      // which calls submitBayesFit + pollUntilDone directly. The scheduler
      // job exists only for persistence and reconnection. The two-phase
      // persist (§8.1) writes the real job state to IDB directly.
    },
  });
}

// ── Automation Bayes submission (doc 28 §11.2.1) ─────────────────────────
//
// Submits a Bayes fit for a graph in the automation pipeline context.
// Gathers graph data, parameter files, snapshot subjects, credentials,
// and callback token — all from fileRegistry (no React dependency).
// Returns the jobId for drain-phase polling.

export interface AutomationBayesSubmitResult {
  jobId: string;
  graphId: string;
  statusUrl?: string;
  patchPath: string;
}

/**
 * Submit a Bayes fit for a graph during automation.
 * Reads graph + param files from fileRegistry, loads credentials,
 * encrypts callback token, and submits.
 *
 * Throws on failure — caller should catch and continue to next graph.
 */
export async function submitBayesFitForAutomation(args: {
  graphFileId: string;
  repo: string;
  branch: string;
}): Promise<AutomationBayesSubmitResult> {
  const { graphFileId, repo, branch } = args;

  // Load graph from fileRegistry (already populated by automation's loadWorkspaceFromIDB)
  const graphFile = fileRegistry.getFile(graphFileId);
  if (!graphFile?.data) {
    throw new Error(`Graph ${graphFileId} not found in fileRegistry`);
  }
  const graphData = graphFile.data as any;

  // Gather referenced parameter files
  const graphEdges: any[] = graphData?.edges ?? [];
  const referencedParamIds = new Set<string>();
  for (const edge of graphEdges) {
    for (const slot of ['p', 'cost_gbp', 'labour_cost']) {
      const pid = (edge as any)[slot]?.id;
      if (pid) referencedParamIds.add(pid);
    }
    for (const cp of (edge.conditional_p ?? [])) {
      if (cp?.id) referencedParamIds.add(cp.id);
    }
  }

  const parametersIndex = fileRegistry.getFile('parameter-index');
  const parameterFiles: Record<string, unknown> = {};
  for (const f of fileRegistry.getAllFiles()) {
    if (f.type === 'parameter' && f.data) {
      const rawId = f.fileId.replace(/^parameter-/, '');
      if (referencedParamIds.has(rawId)) {
        parameterFiles[f.fileId] = f.data;
      }
    }
  }

  // Build snapshot subjects from pinned DSL
  let snapshotSubjects: any[] = [];
  const pinnedDsl = graphData?.dataInterestsDSL;
  if (pinnedDsl && typeof pinnedDsl === 'string' && pinnedDsl.trim()) {
    try {
      const { explodeDSL } = await import('../lib/dslExplosion');
      const { buildFetchPlanProduction } = await import('./fetchPlanBuilderService');
      const { mapFetchPlanToSnapshotSubjects } = await import('./snapshotDependencyPlanService');
      const { parseConstraints } = await import('../lib/queryDSL');
      const { resolveRelativeDate, formatDateUK } = await import('../lib/dateFormat');

      const explodedSlices = await explodeDSL(pinnedDsl);

      for (const sliceDsl of explodedSlices) {
        const constraints = parseConstraints(sliceDsl);
        let dslWindow: { start: string; end: string } | null = null;
        if (constraints.cohort?.start) {
          dslWindow = {
            start: resolveRelativeDate(constraints.cohort.start),
            end: constraints.cohort.end ? resolveRelativeDate(constraints.cohort.end) : formatDateUK(new Date()),
          };
        } else if (constraints.window?.start) {
          dslWindow = {
            start: resolveRelativeDate(constraints.window.start),
            end: constraints.window.end ? resolveRelativeDate(constraints.window.end) : formatDateUK(new Date()),
          };
        }
        if (!dslWindow) continue;

        const { plan } = await buildFetchPlanProduction(graphData, sliceDsl, dslWindow);
        const resolved = await mapFetchPlanToSnapshotSubjects({
          plan,
          analysisType: 'bayes_fit',
          graph: graphData,
          selectedEdgeUuids: [],
          workspace: { repository: repo, branch },
          queryDsl: sliceDsl,
        });
        if (resolved?.subjects) {
          snapshotSubjects.push(...resolved.subjects);
        }
      }

      // Flatten target.targetId → edge_id and add equivalent_hashes
      const { getClosureSet } = await import('./hashMappingsService');
      for (const subj of snapshotSubjects) {
        if (subj.target?.targetId && !subj.edge_id) {
          subj.edge_id = subj.target.targetId;
        }
        if (subj.core_hash && !subj.equivalent_hashes?.length) {
          subj.equivalent_hashes = getClosureSet(subj.core_hash);
        }
      }
    } catch (err: any) {
      sessionLogService.warning('bayes', 'BAYES_AUTO_SNAPSHOT_SUBJECTS_FAILED',
        `Could not build snapshot subjects for ${graphFileId}: ${err.message}`);
    }
  }

  // Load credentials
  const credsResult = await credentialsManager.loadCredentials();
  if (!credsResult.success || !credsResult.credentials) {
    throw new Error('Failed to load credentials for Bayes submission');
  }
  const [owner, repoName] = repo.split('/');
  const gitCred = credsResult.credentials.git.find((g: any) => g.name === repoName || `${g.owner}/${g.name}` === repo);
  if (!gitCred) {
    throw new Error(`No git credentials found for repo: ${repo}`);
  }

  // Fetch config and encrypt callback token (per-graph, fresh — doc 28 F10)
  const config = await fetchBayesConfig();
  const callbackToken = await encryptCallbackToken(
    {
      owner: gitCred.owner,
      repo: gitCred.name,
      token: gitCred.token,
      branch,
      graph_id: graphFileId,
      graph_file_path: `${graphFileId}.yaml`,
    },
    config.webhook_secret,
  );

  // Load forecasting settings
  let forecastingSettings: Record<string, unknown> = {};
  try {
    const { forecastingSettingsService } = await import('./forecastingSettingsService');
    forecastingSettings = await forecastingSettingsService.getForecastingModelSettings() as any;
  } catch { /* Non-fatal: compiler uses defaults */ }

  // Submit
  const jobId = await submitBayesFit({
    graph_id: graphFileId,
    repo,
    branch,
    graph_file_path: `${graphFileId}.yaml`,
    graph_snapshot: graphData,
    parameters_index: parametersIndex?.data ?? {},
    parameter_files: parameterFiles,
    settings: forecastingSettings,
    ...(snapshotSubjects.length > 0 ? { snapshot_subjects: snapshotSubjects } : {}),
    callback_token: callbackToken,
    db_connection: config.db_connection,
    webhook_url: config.webhook_url,
  });

  const patchPath = `_bayes/patch-${jobId}.json`;

  sessionLogService.info('bayes', 'BAYES_AUTO_SUBMITTED',
    `Submitted Bayes fit for ${graphFileId}: jobId=${jobId}, ${snapshotSubjects.length} snapshot subjects`);

  return { jobId, graphId: graphFileId, patchPath };
}
