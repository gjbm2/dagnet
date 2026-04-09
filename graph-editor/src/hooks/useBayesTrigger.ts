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
import {
  fetchBayesConfig,
  encryptCallbackToken,
  submitBayesFit,
  pollUntilDone,
  cancelBayesJob,
} from '../services/bayesService';
import type { BayesJobRecord } from '../services/bayesService';
import { db } from '../db/appDatabase';
import type { BayesFitJobParams } from '../services/bayesReconnectService';

export type BayesTriggerStatus = 'idle' | 'submitting' | 'running' | 'complete' | 'failed';
export type BayesComputeMode = 'local' | 'modal';

import { PYTHON_API_BASE } from '../lib/pythonApiBase';
import { engorgeGraphEdges } from '../lib/bayesEngorge';
import { useViewOverlayMode } from './useViewOverlayMode';

/** URLs for local dev mode (Python server, webhook on Vite dev server). */
const LOCAL_SUBMIT_URL = `${PYTHON_API_BASE}/api/bayes/submit`;
const LOCAL_STATUS_URL = `${PYTHON_API_BASE}/api/bayes/status`;
const LOCAL_CANCEL_URL = `${PYTHON_API_BASE}/api/bayes/cancel`;
const LOCAL_WEBHOOK_URL = `${window.location.origin}/api/bayes-webhook`;
const TUNNEL_START_URL = `${PYTHON_API_BASE}/api/bayes/tunnel/start`;
const TUNNEL_STATUS_URL = `${PYTHON_API_BASE}/api/bayes/tunnel/status`;

interface BayesTriggerState {
  status: BayesTriggerStatus;
  jobId: string | null;
  error: string | null;
  lastResult: BayesJobRecord | null;
}

export function useBayesTrigger(computeMode: BayesComputeMode = 'local') {
  const { state: navState } = useNavigatorContext();
  const { tabs, activeTabId } = useTabContext();
  const { setViewOverlayMode } = useViewOverlayMode();

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
    const isLocal = import.meta.env.DEV && computeMode === 'local';
    const modeLabel = !import.meta.env.DEV ? '(Modal)' : (computeMode === 'modal' ? '(Modal)' : '(local)');

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

      // 4. Gather parameter files — only those referenced by the loaded graph
      const graphData = graphFile.data as any;
      const graphEdges: any[] = graphData?.edges ?? [];
      const referencedParamIds = new Set<string>();
      for (const edge of graphEdges) {
        for (const slot of ['p', 'cost_gbp', 'labour_cost']) {
          const pid = (edge as any)[slot]?.id;
          if (pid) referencedParamIds.add(pid);
        }
        // conditional_p entries
        for (const cp of (edge.conditional_p ?? [])) {
          const cpId = cp?.id;
          if (cpId) referencedParamIds.add(cpId);
        }
      }

      const parametersIndex = fileRegistry.getFile('parameter-index');
      const parameterFiles: Record<string, unknown> = {};
      const allFiles = fileRegistry.getAllFiles();
      for (const f of allFiles) {
        if (f.type === 'parameter' && f.data) {
          // Strip 'parameter-' prefix to get the raw param id for matching
          const rawId = f.fileId.replace(/^parameter-/, '');
          if (referencedParamIds.has(rawId)) {
            parameterFiles[f.fileId] = f.data;
          }
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

          // Flatten target.targetId → edge_id for worker compatibility.
          // The worker expects a flat `edge_id` key, not nested `target.targetId`.
          // Also add equivalent_hashes from hash-mappings so the worker can
          // query all equivalent core_hashes (e.g. bayes-test-* ↔ gm-*).
          const { getClosureSet } = await import('../services/hashMappingsService');
          for (const subj of snapshotSubjects) {
            if (subj.target?.targetId && !subj.edge_id) {
              subj.edge_id = subj.target.targetId;
            }
            if (subj.core_hash && !subj.equivalent_hashes?.length) {
              subj.equivalent_hashes = getClosureSet(subj.core_hash);
            }
          }

          // Log comprehensive commission details
          const commissionLogId = sessionLogService.startOperation(
            'info', 'bayes', 'BAYES_COMMISSION_PLAN',
            `Bayes commission: DSL="${pinnedDsl}", ${explodedSlices.length} slices, ${snapshotSubjects.length} subjects`,
          );
          for (let i = 0; i < explodedSlices.length; i++) {
            sessionLogService.addChild(commissionLogId, 'debug', 'BAYES_SLICE',
              `Slice ${i + 1}/${explodedSlices.length}: "${explodedSlices[i]}"`);
          }
          for (const subj of snapshotSubjects) {
            sessionLogService.addChild(commissionLogId, 'debug', 'BAYES_SUBJECT',
              `Subject: param_id=${subj.param_id || '?'}, edge_id=${subj.edge_id || '?'}, core_hash=${subj.core_hash || '?'}, ` +
              `anchor=${subj.anchor_from || '?'}→${subj.anchor_to || '?'}, sweep=${subj.sweep_from || '?'}→${subj.sweep_to || '?'}, ` +
              `slices=[${(subj.slice_keys || []).join(',')}], read_mode=${subj.read_mode || '?'}, ` +
              `equiv_hashes=${(subj.equivalent_hashes || []).length}`);
          }
          sessionLogService.endOperation(commissionLogId, 'success',
            `${snapshotSubjects.length} subjects from ${explodedSlices.length} slices`);

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
      //
      // Production: always use Modal endpoints from config + production webhook.
      // Dev local:  use local Python server on :9000 + local Vite webhook.
      // Dev modal:  use Modal endpoints + cloudflared tunnel for webhook callback.
      let webhookUrl: string;
      let submitUrl: string | undefined;  // undefined = use config.modal_submit_url
      let statusUrl: string | undefined;
      let cancelUrl: string | undefined;

      if (!import.meta.env.DEV) {
        // Production — Modal endpoints from config, Vercel webhook reachable directly
        webhookUrl = config.webhook_url;
      } else if (isLocal) {
        submitUrl = LOCAL_SUBMIT_URL;
        statusUrl = LOCAL_STATUS_URL;
        cancelUrl = LOCAL_CANCEL_URL;
        webhookUrl = LOCAL_WEBHOOK_URL;
      } else {
        // Dev modal mode: start cloudflared tunnel so Modal can reach our local webhook
        sessionLogService.debug('bayes', 'BAYES_TUNNEL_START', 'Starting cloudflared tunnel for Modal callback…');
        const tunnelResp = await fetch(TUNNEL_START_URL, { method: 'POST' });
        const tunnelData = await tunnelResp.json();
        if (tunnelData.tunnel_url) {
          webhookUrl = `${tunnelData.tunnel_url}/api/bayes-webhook`;
          sessionLogService.debug('bayes', 'BAYES_TUNNEL_READY', `Tunnel ready: ${webhookUrl}`);
        } else {
          throw new Error(`Failed to start cloudflared tunnel: ${tunnelData.error || 'no URL returned'}`);
        }
      }

      sessionLogService.debug('bayes', 'BAYES_DEV_TRIGGER', `Mode: ${computeMode}, webhook: ${webhookUrl}`);

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

      // 7b. Log prior inputs per param file — everything the backend reads
      //     to resolve probability, latency, and warm-start priors.
      {
        const priorLogId = sessionLogService.startOperation(
          'info', 'bayes', 'BAYES_PRIOR_INPUTS',
          `Prior inputs for ${Object.keys(parameterFiles).length} param files`,
        );
        for (const [paramId, pfRaw] of Object.entries(parameterFiles)) {
          const pf = pfRaw as Record<string, any> | undefined;
          if (!pf) continue;

          // Probability prior fields
          const values0 = Array.isArray(pf.values) && pf.values[0] ? pf.values[0] : null;
          const posterior = typeof pf.posterior === 'object' && pf.posterior ? pf.posterior : null;
          const windowSlice = posterior?.slices?.['window()'] ?? null;
          const cohortSlice = posterior?.slices?.['cohort()'] ?? null;
          const latencyBlock = typeof pf.latency === 'object' && pf.latency ? pf.latency : null;
          const modelState = posterior?._model_state ?? null;

          // Determine which prior source the backend will use
          const bayesReset = !!latencyBlock?.bayes_reset;
          const wsAcceptable = windowSlice
            ? (windowSlice.rhat == null || windowSlice.rhat <= 1.1)
              && (windowSlice.ess == null || windowSlice.ess >= 100)
            : false;
          let expectedSource = 'uninformative';
          if (!bayesReset && windowSlice?.alpha && windowSlice?.beta && wsAcceptable) {
            expectedSource = 'warm_start (window slice)';
          } else if (!bayesReset && posterior?.alpha && posterior?.beta) {
            expectedSource = 'warm_start (legacy)';
          } else if (values0?.mean != null && values0?.stdev != null
            && values0.mean > 0 && values0.mean < 1 && values0.stdev > 0) {
            expectedSource = 'moment_matched';
          } else if (values0?.n != null && values0?.k != null
            && values0.n > 0 && values0.k >= 0) {
            expectedSource = 'kn_derived';
          }

          const parts: string[] = [
            `expected_source=${expectedSource}`,
          ];

          // Warm-start: posterior window slice
          if (windowSlice) {
            parts.push(
              `ws_alpha=${windowSlice.alpha ?? '—'}, ws_beta=${windowSlice.beta ?? '—'}, ` +
              `ws_rhat=${windowSlice.rhat ?? '—'}, ws_ess=${windowSlice.ess ?? '—'}, ` +
              `ws_mu_mean=${windowSlice.mu_mean ?? '—'}, ws_sigma_mean=${windowSlice.sigma_mean ?? '—'}`,
            );
          }
          // Legacy posterior alpha/beta
          if (posterior?.alpha || posterior?.beta) {
            parts.push(`legacy_alpha=${posterior.alpha}, legacy_beta=${posterior.beta}`);
          }
          // Point estimates (moment-match / k-n source)
          if (values0) {
            parts.push(
              `mean=${values0.mean ?? '—'}, stdev=${values0.stdev ?? '—'}, ` +
              `n=${values0.n ?? '—'}, k=${values0.k ?? '—'}`,
            );
          }
          // Latency prior inputs
          if (latencyBlock) {
            parts.push(
              `lat_mu=${latencyBlock.mu ?? '—'}, lat_sigma=${latencyBlock.sigma ?? '—'}, ` +
              `onset=${latencyBlock.onset_delta_days ?? '—'}, bayes_reset=${bayesReset}`,
            );
          }
          // Warm-start latency from posterior
          if (windowSlice?.mu_mean != null) {
            parts.push(
              `ws_lat_mu=${windowSlice.mu_mean}, ws_lat_sigma=${windowSlice.sigma_mean ?? '—'}`,
            );
          }
          // Cohort slice warm-start
          if (cohortSlice) {
            parts.push(
              `cohort_mu=${cohortSlice.mu_mean ?? '—'}, cohort_sigma=${cohortSlice.sigma_mean ?? '—'}, ` +
              `cohort_onset=${cohortSlice.onset_mean ?? '—'}, cohort_rhat=${cohortSlice.rhat ?? '—'}, ` +
              `cohort_ess=${cohortSlice.ess ?? '—'}`,
            );
          }
          // Kappa warm-start from _model_state
          if (modelState) {
            const kappaKeys = Object.keys(modelState).filter(k => k.startsWith('kappa_'));
            if (kappaKeys.length > 0) {
              parts.push(`kappa_keys=[${kappaKeys.map(k => `${k}=${modelState[k]}`).join(', ')}]`);
            }
          }

          sessionLogService.addChild(priorLogId, 'debug', 'BAYES_PRIOR_EDGE',
            `${paramId}: ${parts.join(' | ')}`);
        }
        sessionLogService.endOperation(priorLogId, 'success',
          `${Object.keys(parameterFiles).length} param files inspected`);
      }

      // 7c. Engorge graph edges — inject observations and priors from
      //     param files onto graph edges (doc 14 §9A). During the parity
      //     phase we still send param files alongside the engorged graph
      //     so the BE can compare both paths.
      engorgeGraphEdges(graphData, parameterFiles);

      // 7d. Build candidate regimes + MECE dimensions (doc 30 §4.1)
      let candidateRegimesByEdge: Record<string, Array<{ core_hash: string; equivalent_hashes: string[] }>> = {};
      let meceDimensions: string[] = [];
      try {
        const { buildCandidateRegimesByEdge, computeMeceDimensions } = await import('../services/candidateRegimeService');
        const workspace = {
          repository: `${gitCred.owner}/${gitCred.name}`,
          branch: navState.selectedBranch || 'main',
        };
        [candidateRegimesByEdge, meceDimensions] = await Promise.all([
          buildCandidateRegimesByEdge(graphFile.data as any, workspace),
          computeMeceDimensions(graphFile.data as any, workspace),
        ]);
        sessionLogService.info('bayes', 'BAYES_REGIME_CANDIDATES',
          `Built candidate regimes: ${Object.keys(candidateRegimesByEdge).length} edges, ` +
          `${meceDimensions.length} MECE dims: [${meceDimensions.join(', ')}]`);
      } catch (err: any) {
        sessionLogService.warning('bayes', 'BAYES_REGIME_CANDIDATES_FAILED',
          `Failed to build candidate regimes (non-blocking): ${err.message}`);
      }

      // 8. Log payload summary + submit
      const paramFileIds = Object.keys(parameterFiles);
      sessionLogService.info('bayes', 'BAYES_PAYLOAD_SUMMARY',
        `Submitting: graph=${activeTab.fileId}, ${paramFileIds.length} param files, ` +
        `${snapshotSubjects.length} snapshot subjects, mode=${computeMode}`,
        JSON.stringify({
          graph_id: activeTab.fileId,
          graph_file_path: graphFilePath,
          repo: `${gitCred.owner}/${gitCred.name}`,
          branch: navState.selectedBranch || 'main',
          parameter_file_ids: paramFileIds,
          snapshot_subject_count: snapshotSubjects.length,
          snapshot_subjects_preview: snapshotSubjects.map(s => ({
            param_id: s.param_id,
            edge_id: s.edge_id,
            core_hash: s.core_hash,
            read_mode: s.read_mode,
            anchor: `${s.anchor_from}→${s.anchor_to}`,
            sweep: `${s.sweep_from}→${s.sweep_to}`,
            slice_keys: s.slice_keys,
          })),
          forecasting_settings: forecastingSettings,
          webhook_url: webhookUrl,
        }, null, 2));

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
        ...(Object.keys(candidateRegimesByEdge).length > 0 ? { candidate_regimes_by_edge: candidateRegimesByEdge } : {}),
        ...(meceDimensions.length > 0 ? { mece_dimensions: meceDimensions } : {}),
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

      // Two-phase IDB persist (doc 28 §8.1): now that we have the jobId,
      // persist with modalCallId so reconcileFn can probe status on reconnect.
      const jobInstanceId = `bayes-fit:${activeTab.fileId}:${fitStartedAt}`;
      const patchPath = `_bayes/patch-${jobId}.json`;
      const persistParams: BayesFitJobParams = {
        modalCallId: jobId,
        computeMode,
        graphId: activeTab.fileId,
        graphFilePath: `${activeTab.fileId}.yaml`,
        repo: `${gitCred.owner}/${gitCred.name}`,
        branch: navState.selectedBranch || 'main',
        patchPath,
        statusUrl: submitUrl ? submitUrl.replace('/submit', '/status') : undefined,
        webhookUrl,
        submittedAtIso: new Date().toISOString(),
      };
      void db.schedulerJobs.put({
        jobId: jobInstanceId,
        jobDefId: 'bayes-fit',
        status: 'running',
        params: persistParams as any,
        submittedAtMs: fitStartedAt,
        lastUpdatedAtMs: fitStartedAt,
      }).catch(err => {
        console.warn('[useBayesTrigger] Failed to persist job to IDB:', err);
      });

      // 9. Poll until done (signal allows cancel to break out of the loop)
      const finalStatus = await pollUntilDone(jobId, (pollStatus) => {
        if (abortController.signal.aborted) return;
        const elapsedSec = Math.round((Date.now() - fitStartedAt) / 1000);
        let label: string;
        if (pollStatus.status === 'running') {
          const p = pollStatus.progress;
          if (p) {
            const pct = Math.max(0, p.pct);  // clamp: -1 → 0
            label = `Bayes ${modeLabel}: ${graphLabel}`;
            operationRegistryService.setProgress(opId, {
              current: pct,
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
      }, 5_000, 10 * 60 * 1000, statusUrl, abortController.signal);

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

      if (finalStatus.status === 'complete') {
        const r = finalStatus.result as Record<string, unknown> | undefined;
        const ver = r?.version ?? 'unknown';
        const timings = r?.timings as Record<string, number> | undefined;
        const timingSummary = timings ? ` | neon=${timings.neon_ms}ms fitting=${timings.fitting_ms}ms total=${timings.total_ms}ms` : '';
        sessionLogService.success('bayes', 'BAYES_DEV_COMPLETE', `Job ${jobId} complete (v${ver}${timingSummary})`, JSON.stringify(finalStatus.result, null, 2), { jobId });

        // 10. Fetch and apply the Bayes patch file directly.
        //
        // The webhook writes _bayes/patch-{job_id}.json to git. We fetch
        // ONLY that file (not a full pull), apply the posteriors into local
        // parameter and graph files, then cascade to graph edges.
        // No 3-way merge, no conflict risk.
        {
          try {
            const { fetchAndApplyPatch } = await import('../services/bayesPatchService');
            // The patch path is in the webhook response (the worker's _job_id
            // differs from the Modal call_id that the FE tracks as jobId).
            const webhookResp = (r as any)?.webhook_response?.body;
            const patchPath = webhookResp?.patch_path || `_bayes/patch-${jobId}.json`;
            console.log(`[useBayesTrigger] Fetching patch: ${patchPath} (from webhookResp: ${!!webhookResp?.patch_path})`);
            // fetchAndApplyPatch now uses applyPatchAndCascade internally
            // (doc 28 §8.2) — tier 1 writes to param files + graph, tier 2
            // cascades to GraphStore if the graph is open.
            const edgesUpdated = await fetchAndApplyPatch({
              owner: gitCred.owner,
              repo: gitCred.name,
              branch: navState.selectedBranch || 'main',
              token: gitCred.token,
              patchPath,
              graphId: activeTab.fileId,
            });

            console.log(`[useBayesTrigger] Patch applied: ${edgesUpdated} edges updated`);
            if (edgesUpdated > 0) {
              sessionLogService.success('bayes', 'BAYES_PATCH_APPLIED',
                `Applied Bayes posteriors to ${edgesUpdated} edges`);
            } else {
              sessionLogService.warning('bayes', 'BAYES_PATCH_EMPTY',
                'Patch file found but no edges updated');
            }
          } catch (e: any) {
            console.error('[useBayesTrigger] Patch error:', e.message, e);
            sessionLogService.warning('bayes', 'BAYES_PATCH_ERROR',
              `Patch fetch/apply failed: ${e.message}. Patch remains in git for next pull.`);
          }
        }
        // Report complete AFTER patch application so consumers see posteriors.
        // Include quality gate summary in the completion label (doc 13 §1.2).
        {
          const graphFile = fileRegistry.getFile(activeTab.fileId);
          const bayesMeta = (graphFile?.data as any)?._bayes;
          const quality = bayesMeta?.quality as { converged_pct: number; max_rhat: number | null; min_ess: number | null } | undefined;

          if (quality) {
            const { computeGraphQualityTier } = await import('../utils/bayesQualityTier');
            const { tier, label: qualityLabel } = computeGraphQualityTier(quality);
            const completionLabel = `Bayes complete — ${qualityLabel}`;
            operationRegistryService.setLabel(opId, completionLabel);

            // Per-edge quality breakdown (doc 13 §1.3) — check BEFORE
            // completing the operation so we can attach an action button.
            const { computeQualityTier } = await import('../utils/bayesQualityTier');
            const { getGraphStore } = await import('../contexts/GraphStoreContext');
            const store = getGraphStore(activeTab.fileId);
            const edges = store?.getState().graph?.edges || [];
            const failedEdges: string[] = [];
            const warnEdges: string[] = [];
            for (const edge of edges) {
              if (!edge.p?.posterior) continue;
              const edgeTier = computeQualityTier(edge.p.posterior);
              const edgeName = edge.p?.id || edge.uuid || edge.id || '?';
              if (edgeTier.tier === 'failed') failedEdges.push(`${edgeName}: ${edgeTier.reason}`);
              else if (edgeTier.tier === 'warning') warnEdges.push(`${edgeName}: ${edgeTier.reason}`);
            }

            if (failedEdges.length > 0 || warnEdges.length > 0) {
              const detail = [
                ...(failedEdges.length > 0 ? [`Failed (${failedEdges.length}):`, ...failedEdges.map(e => `  ${e}`)] : []),
                ...(warnEdges.length > 0 ? [`Warning (${warnEdges.length}):`, ...warnEdges.map(e => `  ${e}`)] : []),
              ].join('\n');
              sessionLogService.warning('bayes', 'BAYES_QUALITY_GATES',
                `Quality gates: ${failedEdges.length} failed, ${warnEdges.length} warning`,
                detail, { jobId });
            }

            const isWarning = tier === 'poor' || tier === 'very poor';
            const hasEdgeIssues = failedEdges.length > 0 || warnEdges.length > 0;
            const showAction = isWarning || hasEdgeIssues;
            setState({ status: 'complete', jobId, error: null, lastResult: record });
            operationRegistryService.complete(
              opId,
              (isWarning || hasEdgeIssues) ? 'warning' : 'complete',
              undefined,
              showAction ? { label: 'See Forecast Quality', onClick: () => setViewOverlayMode('forecast-quality') } : undefined,
            );
          } else {
            setState({ status: 'complete', jobId, error: null, lastResult: record });
            operationRegistryService.complete(opId, 'complete', undefined);
          }
        }
        // Update persisted job: complete
        void db.schedulerJobs.update(jobInstanceId, {
          status: 'complete', lastUpdatedAtMs: Date.now(), result: finalStatus.result,
        }).catch(() => {});
      } else {
        setState({ status: 'failed', jobId, error: finalStatus.error ?? null, lastResult: record });
        operationRegistryService.complete(opId, 'error', finalStatus.error);
        sessionLogService.error('bayes', 'BAYES_DEV_FAILED', `Job ${jobId} failed: ${finalStatus.error}`, undefined, { jobId });
        // Update persisted job: error
        void db.schedulerJobs.update(jobInstanceId, {
          status: 'error', lastUpdatedAtMs: Date.now(), error: finalStatus.error ?? 'unknown',
        }).catch(() => {});
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
