/**
 * useEdgeSnapshotRetrievals — commissions snapshot retrieval query for an edge.
 *
 * Uses the same code path as the @ asat picker (getSnapshotRetrievalsForEdge)
 * so results are signature-matched and consistent with what the Snapshot Manager shows.
 *
 * Designed for fire-and-forget: call `commission()` on hover, result arrives when ready.
 * If offline or backend unavailable, result stays null (graceful degradation).
 */

import { useState, useCallback, useRef } from 'react';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useTabContext } from '../contexts/TabContext';
import { getSnapshotRetrievalsForEdge } from '../services/snapshotRetrievalsService';
import type { QuerySnapshotRetrievalsResult } from '../services/snapshotWriteService';
import type { GraphData } from '../types';

export interface EdgeSnapshotRetrievalsData {
  /** ISO date strings (YYYY-MM-DD) on which snapshots were retrieved */
  retrievedDays: string[];
  /** Total snapshot row count */
  count: number;
  /** Latest retrieval timestamp */
  latestRetrievedAt: string | null;
}

// Module-level cache: avoid re-fetching for same edge within a session
const cache = new Map<string, EdgeSnapshotRetrievalsData>();

export function useEdgeSnapshotRetrievals(graph: GraphData | undefined) {
  const [data, setData] = useState<EdgeSnapshotRetrievalsData | null>(null);
  const commissionedRef = useRef<string | null>(null);
  const { state: navState } = useNavigatorContext();
  const { tabs, activeTabId } = useTabContext();

  const commission = useCallback((edgeId: string) => {
    if (!graph || !edgeId) return;
    const cacheKey = `${navState.selectedRepo}-${navState.selectedBranch}-${edgeId}`;

    // Already commissioned or cached
    if (commissionedRef.current === cacheKey) return;
    commissionedRef.current = cacheKey;

    const cached = cache.get(cacheKey);
    if (cached) {
      setData(cached);
      return;
    }

    // Resolve currentDSL from active tab
    const activeTab = tabs.find(t => t.id === activeTabId);
    const currentDSL = (activeTab?.editorState as any)?.currentDSL || '';

    const workspace = navState.selectedRepo && navState.selectedBranch
      ? { repository: navState.selectedRepo, branch: navState.selectedBranch }
      : undefined;

    // Fire and forget — result arrives when it arrives
    void getSnapshotRetrievalsForEdge({
      graph: graph as any,
      edgeId,
      effectiveDSL: currentDSL,
      workspace,
    }).then((res: QuerySnapshotRetrievalsResult) => {
      if (res.success && res.count > 0) {
        const result: EdgeSnapshotRetrievalsData = {
          retrievedDays: res.retrieved_days || [],
          count: res.count,
          latestRetrievedAt: res.latest_retrieved_at,
        };
        cache.set(cacheKey, result);
        setData(result);
      }
    }).catch(() => {
      // Graceful degradation: offline or error → no data shown
    });
  }, [graph, navState.selectedRepo, navState.selectedBranch, tabs, activeTabId]);

  return { data, commission };
}

/** Clear the retrievals cache (e.g., after writing new snapshots). */
export function clearEdgeSnapshotRetrievalsCache(): void {
  cache.clear();
}
