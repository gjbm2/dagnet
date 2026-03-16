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
} from '../services/bayesService';
import type { BayesJobRecord } from '../services/bayesService';

export type BayesTriggerStatus = 'idle' | 'submitting' | 'running' | 'complete' | 'failed';

interface BayesTriggerState {
  status: BayesTriggerStatus;
  jobId: string | null;
  error: string | null;
  lastResult: BayesJobRecord | null;
}

export function useBayesTrigger() {
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
          graph_file_path: `${activeTab.fileId}.yaml`,
        },
        config.webhook_secret,
      );

      // 6. Register operation for progress toast
      operationRegistryService.register({
        id: opId,
        kind: 'bayes-fit',
        label: `Bayes fit: ${activeTab.fileId}`,
        status: 'running',
        cancellable: true,
        onCancel: () => { abortRef.current = true; },
      });

      // 7. Submit
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
        webhook_url: config.webhook_url,
      });

      setState(s => ({ ...s, status: 'running', jobId }));
      operationRegistryService.setLabel(opId, `Bayes fit: polling ${jobId.slice(0, 8)}…`);
      sessionLogService.info('bayes', 'BAYES_DEV_SUBMITTED', `Job submitted: ${jobId}`, undefined, { jobId });

      // 8. Poll until done
      const finalStatus = await pollUntilDone(jobId, (status) => {
        if (abortRef.current) return; // won't stop the poll, but stops UI updates
        operationRegistryService.setLabel(opId, `Bayes fit: ${status.status} — ${jobId.slice(0, 8)}`);
      });

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
      } else {
        sessionLogService.error('bayes', 'BAYES_DEV_FAILED', `Job ${jobId} failed: ${finalStatus.error}`, undefined, { jobId });
      }

    } catch (err: any) {
      const msg = err?.message || String(err);
      setState(s => ({ ...s, status: 'failed', error: msg }));
      operationRegistryService.complete(opId, 'error', msg);
      sessionLogService.error('bayes', 'BAYES_DEV_ERROR', `Dev trigger error: ${msg}`);
    }
  }, [navState, tabs, activeTabId]);

  return {
    ...state,
    trigger,
  };
}
