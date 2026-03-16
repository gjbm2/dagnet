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
import { repositoryOperationsService } from '../services/repositoryOperationsService';
import { sessionLogService } from '../services/sessionLogService';
import {
  fetchBayesConfig,
  encryptCallbackToken,
  submitBayesFit,
  pollUntilDone,
} from '../services/bayesService';
import type { BayesJobRecord } from '../services/bayesService';

export type BayesTriggerStatus = 'idle' | 'submitting' | 'running' | 'complete' | 'failed';
export type BayesComputeMode = 'local' | 'modal';

/** URLs for local dev mode (Python server on :9000, webhook on :5173). */
const LOCAL_SUBMIT_URL = 'http://localhost:9000/api/bayes/submit';
const LOCAL_STATUS_URL = 'http://localhost:9000/api/bayes/status';
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

  const abortRef = useRef(false);

  const trigger = useCallback(async () => {
    abortRef.current = false;
    setState({ status: 'submitting', jobId: null, error: null, lastResult: null });

    const opId = `bayes-fit:${Date.now()}`;

    try {
      // 1. Fetch config
      sessionLogService.info('bayes', 'BAYES_DEV_TRIGGER', 'Dev harness: starting Bayes roundtrip');
      const config = await fetchBayesConfig();

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
      const activeTab = tabs.find(t => t.id === activeTabId);
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
      const isLocal = computeMode === 'local';
      let webhookUrl: string;
      const submitUrl = isLocal ? LOCAL_SUBMIT_URL : undefined; // undefined = use config
      const statusUrl = isLocal ? LOCAL_STATUS_URL : undefined;

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

      // 7. Register operation for progress toast
      const graphLabel = activeTab.fileId.replace(/^graph-/, '');
      operationRegistryService.register({
        id: opId,
        kind: 'bayes-fit',
        label: `Bayes ${computeMode === 'modal' ? '(Modal)' : '(local)'}: submitting ${graphLabel}…`,
        status: 'running',
        cancellable: true,
        onCancel: () => { abortRef.current = true; },
      });

      // 8. Submit
      const jobId = await submitBayesFit({
        graph_id: activeTab.fileId,
        repo: `${gitCred.owner}/${gitCred.name}`,
        branch: navState.selectedBranch || 'main',
        graph_file_path: `${activeTab.fileId}.yaml`,
        graph_snapshot: graphFile.data,
        parameters_index: parametersIndex?.data ?? {},
        parameter_files: parameterFiles,
        settings: {},
        callback_token: callbackToken,
        db_connection: config.db_connection,
        webhook_url: webhookUrl,
      }, submitUrl);

      const modeTag = computeMode === 'modal' ? '(Modal)' : '(local)';
      const fitStartedAt = Date.now();
      setState(s => ({ ...s, status: 'running', jobId }));
      operationRegistryService.setLabel(opId, `Bayes ${modeTag}: fitting ${graphLabel}…`);
      sessionLogService.info('bayes', 'BAYES_DEV_SUBMITTED', `Job submitted: ${jobId}`, undefined, { jobId });

      // 9. Poll until done
      const finalStatus = await pollUntilDone(jobId, (pollStatus) => {
        if (abortRef.current) return;
        const elapsedSec = Math.round((Date.now() - fitStartedAt) / 1000);
        const label = pollStatus.status === 'running'
          ? `Bayes ${modeTag}: fitting ${graphLabel} (${elapsedSec}s)…`
          : `Bayes ${modeTag}: ${pollStatus.status} — ${graphLabel}`;
        operationRegistryService.setLabel(opId, label);
      }, isLocal ? 2_000 : 10_000, 10 * 60 * 1000, statusUrl);

      // 9. Done
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
        sessionLogService.success('bayes', 'BAYES_DEV_COMPLETE', `Job ${jobId} complete`, JSON.stringify(finalStatus.result, null, 2), { jobId });

        // 10. Auto-pull the updated graph file so FE reflects the committed changes
        try {
          operationRegistryService.setLabel(opId, `Bayes ${modeTag}: pulling updated ${graphLabel}…`);
          // Re-set status to 'complete' before completing the operation below
          const repoName = gitCred.name;
          const branchName = navState.selectedBranch || 'main';
          const pullResult = await repositoryOperationsService.pullFile(
            activeTab.fileId,
            repoName,
            branchName,
          );
          if (pullResult.success) {
            sessionLogService.success('bayes', 'BAYES_PULL_COMPLETE', `Pulled updated ${graphLabel} after Bayes fit`);
          } else {
            sessionLogService.warning('bayes', 'BAYES_PULL_WARNING', `Pull after Bayes fit: ${pullResult.message}`);
          }
        } catch (pullErr: any) {
          sessionLogService.warning('bayes', 'BAYES_PULL_ERROR', `Auto-pull failed: ${pullErr.message}. Manual pull needed.`);
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
