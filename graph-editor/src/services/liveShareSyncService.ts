/**
 * Live Share Sync Service
 *
 * Share-live refresh pipeline:
 * - Minimal fetch (graph + dependency closure) without workspace clone/pull
 * - Overwrite-seed into share-scoped IndexedDB (no stale reuse)
 * - Record share-scoped "last seen remote HEAD SHA" for remote-ahead tracking
 */

import { getShareBootConfig } from '../lib/shareBootResolver';
import { fetchLiveShareBundle } from './liveShareBootService';
import { fileRegistry } from '../contexts/TabContext';
import { stalenessNudgeService } from './stalenessNudgeService';

export interface LiveShareRefreshResult {
  success: boolean;
  error?: string;
  repo?: string;
  branch?: string;
  graph?: string;
  remoteHeadSha?: string | null;
  seededParameters?: number;
}

export async function refreshLiveShareToLatest(): Promise<LiveShareRefreshResult> {
  const config = getShareBootConfig();
  if (config.mode !== 'live') {
    return { success: false, error: 'Not in live share mode' };
  }

  const { repo, branch, graph } = config;
  if (!repo || !branch || !graph) {
    return { success: false, error: 'Missing required identity params (repo, branch, graph)' };
  }

  const bundle = await fetchLiveShareBundle(
    { repo, branch, graph },
    { operationLabel: 'LIVE_SHARE_REFRESH' }
  );

  if (!bundle.success || !bundle.graphData || !bundle.identity) {
    return { success: false, error: bundle.error || 'Live share refresh failed' };
  }

  const graphFileId = `graph-${bundle.identity.graph}`;

  await fileRegistry.upsertFileClean(
    graphFileId,
    'graph',
    {
      repository: bundle.identity.repo,
      path: bundle.graphPath || `graphs/${bundle.identity.graph}.json`,
      branch: bundle.identity.branch,
    },
    bundle.graphData,
    { sha: bundle.graphSha, lastSynced: Date.now() }
  );

  let seededParameters = 0;
  if (bundle.parameters) {
    for (const [paramId, paramData] of bundle.parameters) {
      const paramFileId = `parameter-${paramId}`;
      await fileRegistry.upsertFileClean(
        paramFileId,
        'parameter',
        {
          repository: bundle.identity.repo,
          path: paramData.path,
          branch: bundle.identity.branch,
        },
        paramData.data,
        { sha: paramData.sha, lastSynced: Date.now() }
      );
      seededParameters++;
    }
  }

  // Record last-seen remote HEAD SHA for share-scoped remote-ahead tracking.
  if (typeof window !== 'undefined' && bundle.remoteHeadSha) {
    stalenessNudgeService.recordShareLastSeenRemoteHeadSha(
      { repository: repo, branch, graph },
      bundle.remoteHeadSha,
      window.localStorage
    );
  }

  // Notify listeners (e.g. live chart share recompute) that a live-share refresh completed.
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('dagnet:liveShareRefreshed', {
          detail: { repo, branch, graph, remoteHeadSha: bundle.remoteHeadSha ?? null },
        })
      );
    }
  } catch {
    // Best-effort only.
  }

  return {
    success: true,
    repo,
    branch,
    graph,
    remoteHeadSha: bundle.remoteHeadSha ?? null,
    seededParameters,
  };
}

class LiveShareSyncService {
  refreshToLatest = refreshLiveShareToLatest;
}

export const liveShareSyncService = new LiveShareSyncService();

