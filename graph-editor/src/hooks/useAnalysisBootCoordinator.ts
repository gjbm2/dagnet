/**
 * Analysis Boot Coordinator Hook
 *
 * Drives the boot state machine for a single analysis compute context.
 * One instance per host (graph tab, chart tab, panel).
 *
 * The hook:
 *   1. Waits for TabContext restore to complete
 *   2. Waits for the graph to be available
 *   3. Collects the union of required planner artefacts
 *   4. Hydrates missing artefacts from IDB into FileRegistry
 *   5. Publishes a monotonic ready epoch when all requirements are met
 *
 * See docs/current/project-contexts/snapshot-chart-boot-redesign-plan.md
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import {
  type AnalysisBootState,
  type AnalysisHostType,
  INITIAL_BOOT_STATE,
  analysisNeedsSnapshots,
  checkBootRequirements,
  hydrateBootRequirements,
} from '../services/analysisBootCoordinatorService';
import { sessionLogService } from '../services/sessionLogService';
import type { CanvasAnalysis } from '../types';

export interface UseAnalysisBootCoordinatorArgs {
  hostType: AnalysisHostType;
  hostId: string;
  graph: any | null;
  workspace?: { repository: string; branch: string };
  analyses: CanvasAnalysis[];
}

export function useAnalysisBootCoordinator(
  args: UseAnalysisBootCoordinatorArgs,
): AnalysisBootState {
  const { hostType, hostId, graph, workspace, analyses } = args;

  const [state, setState] = useState<AnalysisBootState>(INITIAL_BOOT_STATE);
  const epochRef = useRef(0);
  const cycleRef = useRef(0);

  // -----------------------------------------------------------------------
  // Restore gate — track TabContext initialisation
  // -----------------------------------------------------------------------

  const [restoreComplete, setRestoreComplete] = useState(() => {
    try { return !!(window as any).__dagnetTabContextInitDone; } catch { return false; }
  });

  useEffect(() => {
    if (restoreComplete) return;
    const handler = () => setRestoreComplete(true);
    window.addEventListener('dagnet:tabContextInitDone', handler as any);
    try {
      if ((window as any).__dagnetTabContextInitDone) setRestoreComplete(true);
    } catch { /* ignore */ }
    return () => window.removeEventListener('dagnet:tabContextInitDone', handler as any);
  }, [restoreComplete]);

  // -----------------------------------------------------------------------
  // Stable dependency keys — avoid re-evaluation on irrelevant graph changes
  // -----------------------------------------------------------------------

  const graphReady = !!(
    graph
    && Array.isArray(graph?.nodes)
    && Array.isArray(graph?.edges)
  );

  const snapshotAnalysisKey = useMemo(() => {
    return analyses
      .filter(analysisNeedsSnapshots)
      .map(a => {
        const ci = a.content_items?.[0];
        const type = ci?.analysis_type || '';
        const dsl = ci?.analytics_dsl || '';
        const scenarioDsls = (ci?.scenarios || [])
          .map((s: any) => s.effective_dsl || '')
          .join(',');
        return `${a.id}:${type}:${ci?.kind || ''}:${dsl}:${scenarioDsls}`;
      })
      .sort()
      .join('|');
  }, [analyses]);

  const graphStructureKey = useMemo(() => {
    if (!graph) return '';
    const nodes: any[] = graph.nodes || [];
    const nodeIds = nodes
      .map((n: any) => `${n.id || n.uuid}:${n.type || ''}:${n.event_id || ''}`)
      .sort()
      .join(',');
    const edgeQueries = (graph.edges || [])
      .map((e: any) => e.query || '')
      .filter(Boolean)
      .sort()
      .join(',');
    return `${nodeIds}|${edgeQueries}`;
  }, [graph]);

  // Keep latest values in refs so the effect closure reads current data
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const analysesRef = useRef(analyses);
  analysesRef.current = analyses;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  // -----------------------------------------------------------------------
  // Main coordinator state machine
  // -----------------------------------------------------------------------

  useEffect(() => {
    const thisCycle = ++cycleRef.current;

    if (!restoreComplete) {
      setState(prev => prev.status === 'waiting_for_restore' ? prev : {
        ...INITIAL_BOOT_STATE,
        status: 'waiting_for_restore',
      });
      return;
    }

    if (!graphReady) {
      setState(prev => prev.status === 'waiting_for_restore' ? prev : {
        ...INITIAL_BOOT_STATE,
        status: 'waiting_for_restore',
      });
      return;
    }

    let cancelled = false;

    const evaluate = async () => {
      const currentGraph = graphRef.current;
      const currentAnalyses = analysesRef.current;
      const currentWorkspace = workspaceRef.current;

      // Snapshot analyses present but no workspace yet — wait
      const hasSnapshotAnalyses = currentAnalyses.some(analysisNeedsSnapshots);
      if (hasSnapshotAnalyses && !currentWorkspace) {
        setState(prev => prev.status === 'collecting_requirements' ? prev : {
          ...INITIAL_BOOT_STATE,
          status: 'collecting_requirements',
        });
        return;
      }

      setState(prev => prev.status === 'collecting_requirements' ? prev : {
        ...prev,
        status: 'collecting_requirements',
        error: null,
      });

      sessionLogService.info(
        'graph',
        'BOOT_COORDINATOR_COLLECT',
        `Collecting boot requirements for ${hostType}:${hostId}`,
        undefined,
        { hostType, hostId, snapshotAnalysisKey },
      );

      try {
        const result = await checkBootRequirements({
          graph: currentGraph,
          analyses: currentAnalyses,
          workspace: currentWorkspace,
        });

        if (cancelled || thisCycle !== cycleRef.current) return;

        if (result.ready) {
          const newEpoch = ++epochRef.current;
          setState({
            status: 'ready',
            bootReady: true,
            bootReadyEpoch: newEpoch,
            error: null,
            diagnostics: {
              snapshotAnalysisCount: result.snapshotAnalysisCount,
              requiredFileIds: result.requiredFileIds,
              hydratableFileIds: [],
              unavailableFileIds: [],
            },
          });
          sessionLogService.success(
            'graph',
            'BOOT_COORDINATOR_READY',
            `Boot ready for ${hostType}:${hostId}, epoch ${newEpoch}`,
            undefined,
            { hostType, hostId, epoch: newEpoch, requiredFiles: result.requiredFileIds.length },
          );
          return;
        }

        // Files needed but none hydratable → terminal failure
        if (result.hydratableFileIds.length === 0) {
          setState({
            status: 'failed',
            bootReady: false,
            bootReadyEpoch: epochRef.current,
            error: `Missing required artefacts that are not in IndexedDB: ${result.unavailableFileIds.join(', ')}`,
            diagnostics: {
              snapshotAnalysisCount: result.snapshotAnalysisCount,
              requiredFileIds: result.requiredFileIds,
              hydratableFileIds: [],
              unavailableFileIds: result.unavailableFileIds,
            },
          });
          sessionLogService.error(
            'graph',
            'BOOT_COORDINATOR_FAILED',
            `Boot failed for ${hostType}:${hostId}: unavailable artefacts`,
            undefined,
            { unavailableFileIds: result.unavailableFileIds },
          );
          return;
        }

        // Hydration needed
        setState(prev => ({
          ...prev,
          status: 'hydrating',
          error: null,
          diagnostics: {
            snapshotAnalysisCount: result.snapshotAnalysisCount,
            requiredFileIds: result.requiredFileIds,
            hydratableFileIds: result.hydratableFileIds,
            unavailableFileIds: result.unavailableFileIds,
          },
        }));

        sessionLogService.info(
          'graph',
          'BOOT_COORDINATOR_HYDRATE',
          `Hydrating ${result.hydratableFileIds.length} files for ${hostType}:${hostId}`,
          undefined,
          { hydratableFileIds: result.hydratableFileIds },
        );

        await hydrateBootRequirements({
          fileIds: result.hydratableFileIds,
          workspace: currentWorkspace,
        });

        if (cancelled || thisCycle !== cycleRef.current) return;

        // Re-check after hydration
        const recheck = await checkBootRequirements({
          graph: currentGraph,
          analyses: currentAnalyses,
          workspace: currentWorkspace,
        });

        if (cancelled || thisCycle !== cycleRef.current) return;

        if (recheck.ready) {
          const newEpoch = ++epochRef.current;
          setState({
            status: 'ready',
            bootReady: true,
            bootReadyEpoch: newEpoch,
            error: null,
            diagnostics: {
              snapshotAnalysisCount: recheck.snapshotAnalysisCount,
              requiredFileIds: recheck.requiredFileIds,
              hydratableFileIds: [],
              unavailableFileIds: [],
            },
          });
          sessionLogService.success(
            'graph',
            'BOOT_COORDINATOR_READY',
            `Boot ready (post-hydration) for ${hostType}:${hostId}, epoch ${newEpoch}`,
            undefined,
            { hostType, hostId, epoch: newEpoch },
          );
        } else {
          setState({
            status: 'failed',
            bootReady: false,
            bootReadyEpoch: epochRef.current,
            error: `Still missing artefacts after hydration: ${recheck.missingFileIds.join(', ')}`,
            diagnostics: {
              snapshotAnalysisCount: recheck.snapshotAnalysisCount,
              requiredFileIds: recheck.requiredFileIds,
              hydratableFileIds: recheck.hydratableFileIds,
              unavailableFileIds: recheck.unavailableFileIds,
            },
          });
          sessionLogService.error(
            'graph',
            'BOOT_COORDINATOR_FAILED',
            `Boot failed after hydration for ${hostType}:${hostId}`,
            undefined,
            { missingFileIds: recheck.missingFileIds },
          );
        }
      } catch (err: any) {
        if (cancelled || thisCycle !== cycleRef.current) return;
        const msg = err?.message || String(err);
        setState(prev => ({
          ...prev,
          status: 'failed',
          bootReady: false,
          error: msg,
        }));
        sessionLogService.error(
          'graph',
          'BOOT_COORDINATOR_ERROR',
          `Boot coordinator error for ${hostType}:${hostId}: ${msg}`,
          undefined,
          { hostType, hostId },
        );
      }
    };

    void evaluate();

    return () => { cancelled = true; };
  }, [
    restoreComplete,
    graphReady,
    graphStructureKey,
    snapshotAnalysisKey,
    workspace?.repository,
    workspace?.branch,
    hostType,
    hostId,
  ]);

  return state;
}
