/**
 * useBayesTrigger — dev-only hook for triggering a Bayes roundtrip.
 *
 * Wires up bayesService with credentials, graph context, and operation tracking.
 * All behaviour lives here; the DevBayesTrigger component is a thin access point.
 */

import { useState, useCallback, useRef } from 'react';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useTabContext, fileRegistry } from '../contexts/TabContext';
import { credentialsManager } from '../lib/credentials';
import { operationRegistryService } from '../services/operationRegistryService';
import { sessionLogService } from '../services/sessionLogService';
import { startNonBlockingPull } from '../services/nonBlockingPullService';
import { dispatchOpenConflictModal } from './usePullAll';
import {
  fetchBayesConfig,
  encryptCallbackToken,
  submitBayesFit,
  pollUntilDone,
  cancelBayesJob,
} from '../services/bayesService';
import type { BayesJobRecord } from '../services/bayesService';

export type BayesTriggerStatus = 'idle' | 'submitting' | 'running' | 'complete' | 'failed';
export type BayesComputeMode = 'local' | 'modal';

/** URLs for local dev mode (Python server on :9000, webhook on :5173). */
const LOCAL_SUBMIT_URL = 'http://localhost:9000/api/bayes/submit';
const LOCAL_STATUS_URL = 'http://localhost:9000/api/bayes/status';
const LOCAL_CANCEL_URL = 'http://localhost:9000/api/bayes/cancel';
const LOCAL_WEBHOOK_URL = 'http://localhost:5173/api/bayes-webhook';
const TUNNEL_START_URL = 'http://localhost:9000/api/bayes/tunnel/start';
const TUNNEL_STATUS_URL = 'http://localhost:9000/api/bayes/tunnel/status';

interface BayesTriggerState {
  status: BayesTriggerStatus;
  jobId: string | null;
  error: string | null;
  lastResult: BayesJobRecord | null;
}

export function useBayesTrigger(computeMode: BayesComputeMode = 'local') {
  const { state: navState } = useNavigatorContext();
  const { tabs, activeTabId } = useTabContext();

  const [state, setState] = useState<BayesTriggerState>({
    status: 'idle',
    jobId: null,
    error: null,
    lastResult: null,
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const trigger = useCallback(async () => {
    // Abort any previous in-flight trigger
    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    jobIdRef.current = null;

    setState({ status: 'submitting', jobId: null, error: null, lastResult: null });

    const opId = `bayes-fit:${Date.now()}`;
    const isLocal = computeMode === 'local';
    const modeLabel = computeMode === 'modal' ? '(Modal)' : '(local)';

    // Get graph label early so the toast can appear immediately
    const activeTab = tabs.find(t => t.id === activeTabId);
    const graphLabel = activeTab
      ? activeTab.fileId.replace(/^graph-/, '')
      : 'unknown';

    // Register operation immediately so toast appears before slow setup steps
    operationRegistryService.register({
      id: opId,
      kind: 'bayes-fit',
      label: `Bayes ${modeLabel}: preparing ${graphLabel}…`,
      status: 'running',
      cancellable: false,
    });

    try {
      // 1. Fetch config
      console.log('[useBayesTrigger] trigger() called, mode:', computeMode);
      sessionLogService.info('bayes', 'BAYES_DEV_TRIGGER', 'Dev harness: starting Bayes roundtrip');
      const config = await fetchBayesConfig();
      console.log('[useBayesTrigger] config fetched, webhook_url:', config.webhook_url, 'submit_url:', isLocal ? LOCAL_SUBMIT_URL : config.modal_submit_url);

      // 2. Load credentials
      console.log('[useBayesTrigger] loading credentials, selectedRepo:', navState.selectedRepo);

      // 2. Load credentials
      const credsResult = await credentialsManager.loadCredentials();
      if (!credsResult.success || !credsResult.credentials) {
        throw new Error('Failed to load credentials');
      }
      const gitCred = credsResult.credentials.git.find(
        (g: any) => g.name === navState.selectedRepo,
      );
      if (!gitCred) {
        throw new Error(`No git credentials found for repo: ${navState.selectedRepo}`);
      }

      // 3. Get current graph context
      if (!activeTab) throw new Error('No active tab');

      const graphFile = fileRegistry.getFile(activeTab.fileId);
      if (!graphFile || graphFile.type !== 'graph') {
        throw new Error('Active tab is not a graph file');
      }
      const graphFilePath = graphFile.source?.path;
      if (!graphFilePath) {
        throw new Error('Graph file has no source path — is it saved to a repo?');
      }

      // 4. Gather parameter files
      const parametersIndex = fileRegistry.getFile('parameter-index');
      const parameterFiles: Record<string, unknown> = {};
      const allFiles = fileRegistry.getAllFiles();
      for (const f of allFiles) {
        if (f.type === 'parameter' && f.data) {
          parameterFiles[f.fileId] = f.data;
        }
      }

      // 4b. Build snapshot subjects from pinned DSL (Phase S)
      //
      // The pinned DSL (dataInterestsDSL) may be compound:
      //   "context(channel);context(device).window(-90d:)"
      // This must be exploded into atomic slices first, then each slice
      // gets its own fetch plan and snapshot subjects — same as the
      // retrieve-all-slices service does for data fetching.
      let snapshotSubjects: any[] = [];
      const pinnedDsl = (graphFile.data as any)?.dataInterestsDSL;
      if (pinnedDsl && typeof pinnedDsl === 'string' && pinnedDsl.trim()) {
        try {
          const { explodeDSL } = await import('../lib/dslExplosion');
          const { buildFetchPlanProduction } = await import('../services/fetchPlanBuilderService');
          const { mapFetchPlanToSnapshotSubjects } = await import('../services/snapshotDependencyPlanService');
          const { parseConstraints } = await import('../lib/queryDSL');
          const { resolveRelativeDate, formatDateUK } = await import('../lib/dateFormat');

          const explodedSlices = await explodeDSL(pinnedDsl);
          if (explodedSlices.length === 0) {
            sessionLogService.info('bayes', 'BAYES_NO_EXPLODED_SLICES',
              'Pinned DSL produced no slices after explosion');
          }

          const workspace = {
            repository: `${gitCred.owner}/${gitCred.name}`,
            branch: navState.selectedBranch || 'main',
          };

          for (const sliceDsl of explodedSlices) {
            // Derive date range from this slice's window/cohort clause
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

            const { plan } = await buildFetchPlanProduction(graphFile.data as any, sliceDsl, dslWindow);
            const resolved = await mapFetchPlanToSnapshotSubjects({
              plan,
              analysisType: 'bayes_fit',
              graph: graphFile.data as any,
              selectedEdgeUuids: [],
              workspace,
              queryDsl: sliceDsl,
            });
            if (resolved?.subjects) {
              snapshotSubjects.push(...resolved.subjects);
            }
          }

          if (snapshotSubjects.length > 0) {
            sessionLogService.info('bayes', 'BAYES_SNAPSHOT_SUBJECTS',
              `Built ${snapshotSubjects.length} snapshot subjects from ${explodedSlices.length} exploded slices`);
          }
        } catch (err: any) {
          // Non-fatal: fall back to param-file-only evidence
          sessionLogService.warning('bayes', 'BAYES_SNAPSHOT_SUBJECTS_FAILED',
            `Could not build snapshot subjects: ${err.message} — falling back to param files`);
        }
      } else {
        sessionLogService.info('bayes', 'BAYES_NO_PINNED_DSL',
          'No dataInterestsDSL on graph — snapshot evidence not available');
      }

      // 4c. Load forecasting settings
      let forecastingSettings: Record<string, unknown> = {};
      try {
        const { forecastingSettingsService } = await import('../services/forecastingSettingsService');
        forecastingSettings = await forecastingSettingsService.getForecastingModelSettings() as any;
      } catch {
        // Non-fatal: compiler uses defaults
      }

      // 5. Encrypt callback token
      const callbackToken = await encryptCallbackToken(
        {
          owner: gitCred.owner,
          repo: gitCred.name,
          token: gitCred.token,
          branch: navState.selectedBranch || 'main',
          graph_id: activeTab.fileId,
          graph_file_path: graphFilePath,
        },
        config.webhook_secret,
      );

      // 6. Resolve URLs based on compute mode
      let webhookUrl: string;
      const submitUrl = isLocal ? LOCAL_SUBMIT_URL : undefined; // undefined = use config
      const statusUrl = isLocal ? LOCAL_STATUS_URL : undefined;
      const cancelUrl = isLocal ? LOCAL_CANCEL_URL : undefined;

      if (isLocal) {
        webhookUrl = LOCAL_WEBHOOK_URL;
      } else {
        // Modal mode: start cloudflared tunnel so Modal can reach our local webhook
        sessionLogService.info('bayes', 'BAYES_TUNNEL_START', 'Starting cloudflared tunnel for Modal callback…');
        const tunnelResp = await fetch(TUNNEL_START_URL, { method: 'POST' });
        const tunnelData = await tunnelResp.json();
        if (tunnelData.tunnel_url) {
          webhookUrl = `${tunnelData.tunnel_url}/api/bayes-webhook`;
          sessionLogService.info('bayes', 'BAYES_TUNNEL_READY', `Tunnel ready: ${webhookUrl}`);
        } else {
          throw new Error(`Failed to start cloudflared tunnel: ${tunnelData.error || 'no URL returned'}`);
        }
      }

      sessionLogService.info('bayes', 'BAYES_DEV_TRIGGER', `Mode: ${computeMode}, webhook: ${webhookUrl}`);

      // 7. Wire up cancel handler now that we have URLs
      const handleCancel = () => {
        const jid = jobIdRef.current;
        if (!jid) return;

        // Show "cancelling" state while we wait for confirmation
        operationRegistryService.setLabel(opId, `Bayes ${modeLabel}: cancelling ${graphLabel}…`);
        operationRegistryService.setCancellable(opId, undefined, false);

        cancelBayesJob(jid, cancelUrl).then(() => {
          // Cancel confirmed — abort polling, mark cancelled
          abortController.abort();
          setState(s => ({ ...s, status: 'failed', error: 'Cancelled by user' }));
          operationRegistryService.complete(opId, 'cancelled', 'Cancelled by user');
        }).catch((err) => {
          // Cancel failed — restore cancellable state so user can retry
          sessionLogService.warning('bayes', 'BAYES_CANCEL_FAILED', `Cancel request failed: ${err.message}`);
          operationRegistryService.setLabel(opId, `Bayes ${modeLabel}: fitting ${graphLabel}… (cancel failed)`);
          operationRegistryService.setCancellable(opId, handleCancel, true);
        });
      };

      operationRegistryService.setLabel(opId, `Bayes ${modeLabel}: submitting ${graphLabel}…`);
      operationRegistryService.setCancellable(opId, handleCancel, true);

      // 8. Submit
      const jobId = await submitBayesFit({
        graph_id: activeTab.fileId,
        repo: `${gitCred.owner}/${gitCred.name}`,
        branch: navState.selectedBranch || 'main',
        graph_file_path: `${activeTab.fileId}.yaml`,
        graph_snapshot: graphFile.data,
        parameters_index: parametersIndex?.data ?? {},
        parameter_files: parameterFiles,
        settings: {
          ...forecastingSettings,
          ...(new URLSearchParams(window.location.search).has('placeholder') ? { placeholder: true } : {}),
        },
        ...(snapshotSubjects.length > 0 ? { snapshot_subjects: snapshotSubjects } : {}),
        callback_token: callbackToken,
        db_connection: config.db_connection,
        webhook_url: webhookUrl,
      }, submitUrl);


      console.log('[useBayesTrigger] submitted, jobId:', jobId);
      const fitStartedAt = Date.now();
      jobIdRef.current = jobId;
      setState(s => ({ ...s, status: 'running', jobId }));
      operationRegistryService.setLabel(opId, `Bayes ${modeLabel}: fitting ${graphLabel}…`);
      sessionLogService.info('bayes', 'BAYES_DEV_SUBMITTED', `Job submitted: ${jobId}`, undefined, { jobId });

      // 9. Poll until done (signal allows cancel to break out of the loop)
      const finalStatus = await pollUntilDone(jobId, (pollStatus) => {
        if (abortController.signal.aborted) return;
        const elapsedSec = Math.round((Date.now() - fitStartedAt) / 1000);
        let label: string;
        if (pollStatus.status === 'running') {
          const p = pollStatus.progress;
          if (p) {
            label = `Bayes ${modeLabel}: ${p.detail || p.stage} — ${graphLabel}`;
            operationRegistryService.setProgress(opId, {
              current: p.pct,
              total: 100,
              detail: p.detail || p.stage,
            });
          } else {
            label = `Bayes ${modeLabel}: starting ${graphLabel} (${elapsedSec}s)…`;
          }
        } else {
          label = `Bayes ${modeLabel}: ${pollStatus.status} — ${graphLabel}`;
        }
        operationRegistryService.setLabel(opId, label);
      }, isLocal ? 2_000 : 3_000, 10 * 60 * 1000, statusUrl, abortController.signal);

      // If cancelled, onCancel already handled state + registry — bail out
      if (finalStatus.status === 'cancelled') return;

      // 10. Done
      const record: BayesJobRecord = {
        job_id: jobId,
        graph_id: activeTab.fileId,
        submitted_at: Date.now(),
        status: finalStatus.status === 'complete' ? 'vendor-complete' : 'failed',
        last_polled_at: Date.now(),
        result: finalStatus,
        error: finalStatus.error,
      };

      setState({ status: finalStatus.status === 'complete' ? 'complete' : 'failed', jobId, error: finalStatus.error ?? null, lastResult: record });
      operationRegistryService.complete(opId, finalStatus.status === 'complete' ? 'complete' : 'error', finalStatus.error);

      if (finalStatus.status === 'complete') {
        const r = finalStatus.result as Record<string, unknown> | undefined;
        const ver = r?.version ?? 'unknown';
        const timings = r?.timings as Record<string, number> | undefined;
        const timingSummary = timings ? ` | neon=${timings.neon_ms}ms fitting=${timings.fitting_ms}ms total=${timings.total_ms}ms` : '';
        sessionLogService.success('bayes', 'BAYES_DEV_COMPLETE', `Job ${jobId} complete (v${ver}${timingSummary})`, JSON.stringify(finalStatus.result, null, 2), { jobId });

        // 10. Non-blocking pull: countdown → 3-way merge → cascade.
        // Uses the same infrastructure as daily automation pulls:
        // - Shows countdown in progress indicator (user can cancel)
        // - 3-way merge preserves local changes (doesn't force-overwrite)
        // - Surfaces conflicts via toast with "Resolve" action
        // - On success: triggers "Get All from Files" to cascade posteriors
        //   from param files to graph edges
        {
          const repoName = gitCred.name;
          const branchName = navState.selectedBranch || 'main';

          startNonBlockingPull({
            repository: repoName,
            branch: branchName,
            countdownSeconds: 5,
            onComplete: async () => {
              // After successful pull, cascade param file data → graph edges.
              // This propagates posteriors from IDB param files to graph edges
              // via the same file-to-graph sync used by "Get from File".
              sessionLogService.info('bayes', 'BAYES_POST_PULL_CASCADE',
                'Cascading posteriors from param files to graph edges');
              try {
                const { getParameterFromFile } = await import('../services/dataOperations/fileToGraphSync');
                const { getGraphStore } = await import('../contexts/GraphStoreContext');
                const store = getGraphStore(activeTab.fileId);
                if (!store) throw new Error('No graph store');
                const currentDSL = store.getState().currentDSL || '';
                const setGraph = (g: any) => { if (g) store.getState().setGraph(g); };
                const graph = store.getState().graph;
                let cascaded = 0;
                for (const edge of (graph?.edges || [])) {
                  const paramId = edge.p?.id;
                  if (!paramId) continue;
                  await getParameterFromFile({
                    paramId,
                    edgeId: edge.uuid || edge.id,
                    graph: store.getState().graph,
                    setGraph,
                    targetSlice: currentDSL,
                  });
                  cascaded++;
                }
                sessionLogService.success('bayes', 'BAYES_CASCADE_COMPLETE',
                  `Cascaded ${cascaded} params from files to graph`);
              } catch (e: any) {
                sessionLogService.warning('bayes', 'BAYES_CASCADE_ERROR',
                  `Post-pull cascade failed: ${e.message}. Use Data > Get All from Files manually.`);
              }
            },
            onConflicts: (conflicts, pullOpId) => {
              // Surface conflicts via the persistent listener in useStalenessNudges.
              dispatchOpenConflictModal(conflicts, pullOpId);
            },
          });
        }
      } else {
        sessionLogService.error('bayes', 'BAYES_DEV_FAILED', `Job ${jobId} failed: ${finalStatus.error}`, undefined, { jobId });
      }

    } catch (err: any) {
      const msg = err?.message || String(err);
      setState(s => ({ ...s, status: 'failed', error: msg }));
      operationRegistryService.complete(opId, 'error', msg);
      sessionLogService.error('bayes', 'BAYES_DEV_ERROR', `Dev trigger error: ${msg}`);
    }
  }, [navState, tabs, activeTabId, computeMode]);

  return {
    ...state,
    trigger,
  };
}
