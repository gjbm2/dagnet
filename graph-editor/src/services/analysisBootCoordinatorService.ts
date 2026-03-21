/**
 * Analysis Boot Coordinator Service
 *
 * Centralised ownership of analysis boot readiness. Replaces the distributed
 * per-chart boot orchestration that previously lived in useCanvasAnalysisCompute,
 * analysisComputePreparationService, and snapshotSubjectResolutionService.
 *
 * The coordinator answers ONE question per compute context:
 *   "Is it safe for analyses to compute now?"
 *
 * See docs/current/project-contexts/snapshot-chart-boot-redesign-plan.md
 */

import { ANALYSIS_TYPES } from '../components/panels/analysisTypes';
import {
  getSnapshotPlannerInputsStatus,
  hydrateSnapshotPlannerInputs,
} from './snapshotSubjectResolutionService';
import type { CanvasAnalysis } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AnalysisBootStatus =
  | 'idle'
  | 'waiting_for_restore'
  | 'collecting_requirements'
  | 'hydrating'
  | 'ready'
  | 'failed';

export type AnalysisHostType = 'graph-tab' | 'chart-tab' | 'panel';

export interface AnalysisBootDiagnostics {
  snapshotAnalysisCount: number;
  requiredFileIds: string[];
  hydratableFileIds: string[];
  unavailableFileIds: string[];
}

export interface AnalysisBootState {
  status: AnalysisBootStatus;
  bootReady: boolean;
  bootReadyEpoch: number;
  error: string | null;
  diagnostics: AnalysisBootDiagnostics;
}

export const INITIAL_BOOT_STATE: AnalysisBootState = {
  status: 'idle',
  bootReady: false,
  bootReadyEpoch: 0,
  error: null,
  diagnostics: {
    snapshotAnalysisCount: 0,
    requiredFileIds: [],
    hydratableFileIds: [],
    unavailableFileIds: [],
  },
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a canvas analysis requires snapshot-backed compute.
 *
 * Mirrors the logic previously inlined in useCanvasAnalysisCompute:
 *   - the analysis type must declare a snapshotContract
 *   - comparison types only need snapshots when chart_kind is time_series
 */
const COMPARISON_TYPES = new Set(['branch_comparison', 'outcome_comparison', 'multi_branch_comparison', 'multi_outcome_comparison']);

export function analysisNeedsSnapshots(analysis: CanvasAnalysis): boolean {
  const analysisType = analysis.recipe?.analysis?.analysis_type;
  if (!analysisType) return false;
  const meta = ANALYSIS_TYPES.find(t => t.id === analysisType);
  if (!meta?.snapshotContract) return false;
  if (COMPARISON_TYPES.has(analysisType) && analysis.chart_kind !== 'time_series') return false;
  return true;
}

/**
 * Collect all DSL strings across snapshot-backed analyses and the graph
 * for context-key extraction during requirement collection.
 */
export function collectSnapshotDslStrings(
  analyses: CanvasAnalysis[],
  graph: any,
): string[] {
  const dsls: string[] = [];
  for (const a of analyses) {
    if (!analysisNeedsSnapshots(a)) continue;
    const dsl = a.content_items?.[0]?.analytics_dsl || a.recipe?.analysis?.analytics_dsl;
    if (dsl) dsls.push(dsl);
    for (const s of a.recipe?.scenarios || []) {
      if ((s as any).effective_dsl) dsls.push((s as any).effective_dsl);
    }
  }
  if (graph?.currentQueryDSL) dsls.push(graph.currentQueryDSL);
  if (graph?.baseDSL) dsls.push(graph.baseDSL);
  return dsls;
}

// ---------------------------------------------------------------------------
// Requirement collection
// ---------------------------------------------------------------------------

export interface BootRequirementCheckResult {
  ready: boolean;
  snapshotAnalysisCount: number;
  requiredFileIds: string[];
  missingFileIds: string[];
  hydratableFileIds: string[];
  unavailableFileIds: string[];
}

/**
 * Collect the union of required planner artefacts across ALL snapshot-backed
 * analyses in a compute context and classify each as present, hydratable
 * (in IDB), or unavailable.
 *
 * This replaces the per-analysis calls to getSnapshotPlannerInputsStatus
 * that previously happened inside useCanvasAnalysisCompute and AnalyticsPanel.
 */
export async function checkBootRequirements(args: {
  graph: any;
  analyses: CanvasAnalysis[];
  workspace?: { repository: string; branch: string };
}): Promise<BootRequirementCheckResult> {
  const snapshotAnalyses = args.analyses.filter(analysisNeedsSnapshots);

  if (snapshotAnalyses.length === 0) {
    return {
      ready: true,
      snapshotAnalysisCount: 0,
      requiredFileIds: [],
      missingFileIds: [],
      hydratableFileIds: [],
      unavailableFileIds: [],
    };
  }

  const dslStrings = collectSnapshotDslStrings(args.analyses, args.graph);

  const status = await getSnapshotPlannerInputsStatus({
    scenarioGraph: args.graph,
    workspace: args.workspace,
    dslStrings,
  });

  return {
    ready: status.ready,
    snapshotAnalysisCount: snapshotAnalyses.length,
    requiredFileIds: status.requiredFileIds,
    missingFileIds: status.missingFileIds,
    hydratableFileIds: status.hydratableFileIds,
    unavailableFileIds: status.unavailableFileIds,
  };
}

/**
 * Hydrate missing planner artefacts from IndexedDB into FileRegistry.
 * Delegates to the existing hydration primitive.
 */
export async function hydrateBootRequirements(args: {
  fileIds: string[];
  workspace?: { repository: string; branch: string };
}): Promise<void> {
  return hydrateSnapshotPlannerInputs(args);
}
