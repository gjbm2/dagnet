/**
 * Analysis Boot Context
 *
 * Provides coordinator boot state to all analysis consumers within a host.
 * During the migration period, the context is optional — consumers that find
 * no provider fall back to their existing boot logic.
 *
 * See docs/current/project-contexts/snapshot-chart-boot-redesign-plan.md
 */

import React, { createContext, useContext, useMemo } from 'react';
import { useGraphStore } from './GraphStoreContext';
import { useFileState } from './TabContext';
import {
  useAnalysisBootCoordinator,
  type UseAnalysisBootCoordinatorArgs,
} from '../hooks/useAnalysisBootCoordinator';
import type {
  AnalysisBootState,
  AnalysisBootStatus,
  AnalysisHostType,
} from '../services/analysisBootCoordinatorService';

// Re-export types for consumer convenience
export type { AnalysisBootState, AnalysisBootStatus, AnalysisHostType };

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AnalysisBootContext = createContext<AnalysisBootState | null>(null);

/**
 * Consume the boot coordinator state. Returns null when no provider is
 * mounted (e.g. in a host that has not yet been migrated). Consumers
 * should fall back to legacy logic when null.
 */
export function useAnalysisBootContext(): AnalysisBootState | null {
  return useContext(AnalysisBootContext);
}

// ---------------------------------------------------------------------------
// Graph-tab host adapter
// ---------------------------------------------------------------------------

interface GraphTabBootProviderProps {
  fileId: string;
  tabId?: string;
  children: React.ReactNode;
}

/**
 * Host adapter for graph tabs. Subscribes to the graph store and file state,
 * derives coordinator inputs, and provides boot state to children.
 *
 * This component sits between GraphStoreProvider and GraphEditorInner so
 * that GraphEditorInner itself does not re-render from coordinator state
 * changes.
 */
export function GraphTabBootProvider({ fileId, tabId, children }: GraphTabBootProviderProps) {
  const { graph } = useGraphStore();
  const fileState = useFileState(fileId);

  const workspace = useMemo(() => {
    const repository = fileState.source?.repository;
    const branch = fileState.source?.branch;
    return (repository && branch) ? { repository, branch } : undefined;
  }, [fileState.source?.repository, fileState.source?.branch]);

  const analyses = useMemo(
    () => (graph as any)?.canvasAnalyses || [],
    [(graph as any)?.canvasAnalyses],
  );

  const coordinatorArgs: UseAnalysisBootCoordinatorArgs = useMemo(() => ({
    hostType: 'graph-tab' as const,
    hostId: tabId || fileId,
    graph,
    workspace,
    analyses,
  }), [graph, workspace, analyses, tabId, fileId]);

  const bootState = useAnalysisBootCoordinator(coordinatorArgs);

  return (
    <AnalysisBootContext.Provider value={bootState}>
      {children}
    </AnalysisBootContext.Provider>
  );
}
