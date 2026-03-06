/**
 * Snapshot Subject Resolution Service
 *
 * Resolves DB-snapshot subjects for a given scenario, composing:
 *   - analytics DSL (from/to — which path to analyse)
 *   - query DSL (window/cohort/asat/context — data scope)
 *
 * Extracted from AnalyticsPanel so both the panel and canvas analysis
 * compute hooks can share the same resolution logic.
 */

import {
  mapFetchPlanToSnapshotSubjects,
  composeSnapshotDsl,
  extractDateRangeFromDSL,
  type SnapshotSubjectRequest,
} from './snapshotDependencyPlanService';
import { buildFetchPlanProduction } from './fetchPlanBuilderService';
import { querySelectionUuids } from '../hooks/useQuerySelectionUuids';

export interface SnapshotResolutionParams {
  /** The scenario-specific graph (with params baked in) */
  scenarioGraph: any;
  /** Analytics DSL — the from/to path expression */
  analyticsDsl: string;
  /** Scenario identifier (for logging) */
  scenarioId: string;
  /** Analysis type id (e.g. 'lag_histogram', 'daily_conversions') */
  analysisType: string;
  /** Workspace identity — required for DB lookups */
  workspace: { repository: string; branch: string };
  /** Returns the full composited query DSL for the given scenario */
  getQueryDslForScenario: (scenarioId: string) => string;
}

export interface SnapshotResolutionResult {
  subjects: SnapshotSubjectRequest[];
  snapshotDsl: string;
}

/**
 * Resolve snapshot subjects for a single scenario.
 *
 * Composes a full snapshot DSL by merging the analytics DSL (from/to)
 * with the query DSL (window/cohort/asat/context). If the analytics DSL
 * already has temporal or context clauses, those take priority.
 *
 * THROWS on failure — snapshot analysis types must not silently fall
 * back to standard analysis.
 */
export async function resolveSnapshotSubjectsForScenario(
  params: SnapshotResolutionParams,
): Promise<SnapshotResolutionResult> {
  const {
    scenarioGraph,
    analyticsDsl,
    scenarioId,
    analysisType,
    workspace,
    getQueryDslForScenario,
  } = params;

  const scenarioQueryDsl = getQueryDslForScenario(scenarioId);
  const snapshotDsl = composeSnapshotDsl(analyticsDsl, scenarioQueryDsl);

  console.log('[SnapshotResolution] Snapshot DSL composed:', snapshotDsl,
    'from analyticsDsl:', analyticsDsl, 'queryDsl:', scenarioQueryDsl);

  const dslWindow = extractDateRangeFromDSL(snapshotDsl);
  if (!dslWindow) {
    throw new Error(
      `No date range for snapshot analysis. The query DSL must include a window() or cohort() clause.\n\n` +
      `Analytics DSL: ${analyticsDsl}\nQuery DSL: ${scenarioQueryDsl}\nComposed: ${snapshotDsl}`,
    );
  }

  console.log('[SnapshotResolution] Snapshot DSL window:', dslWindow);

  const { plan } = await buildFetchPlanProduction(scenarioGraph, snapshotDsl, dslWindow);
  console.log('[SnapshotResolution] Fetch plan built:', plan.items.length, 'items, types:',
    plan.items.map(i => `${i.type}:${i.itemKey}:sig=${!!i.querySignature}`).join(', '));

  const edgeUuids = querySelectionUuids();
  const resolverResult = await mapFetchPlanToSnapshotSubjects({
    plan,
    analysisType,
    graph: scenarioGraph,
    selectedEdgeUuids: edgeUuids.selectedEdgeUuids,
    workspace,
    queryDsl: snapshotDsl,
  });

  if (!resolverResult) {
    throw new Error(
      `Snapshot subject resolution returned nothing. The analysis type "${analysisType}" may not have a valid snapshotContract.`,
    );
  }

  if (resolverResult.skipped.length > 0) {
    console.warn('[SnapshotResolution] Snapshot subjects skipped:', resolverResult.skipped);
  }

  if (resolverResult.subjects.length === 0) {
    const skipReasons = resolverResult.skipped.map(s => `${s.subjectId}: ${s.reason}`).join('\n');
    throw new Error(
      `No snapshot subjects resolved for analysis.\n\n` +
      `Skipped:\n${skipReasons || '(none)'}\n\nPlan items: ${plan.items.length}\nComposed DSL: ${snapshotDsl}`,
    );
  }

  console.log('[SnapshotResolution] Resolved snapshot subjects:', resolverResult.subjects.length);
  for (const subj of resolverResult.subjects) {
    console.log('[SnapshotResolution] Snapshot subject:', {
      subject_id: subj.subject_id,
      param_id: subj.param_id,
      core_hash: subj.core_hash,
      read_mode: subj.read_mode,
      anchor_from: subj.anchor_from,
      anchor_to: subj.anchor_to,
      sweep_from: subj.sweep_from,
      sweep_to: subj.sweep_to,
      slice_keys: subj.slice_keys,
      sig_preview: subj.canonical_signature?.substring(0, 80) + '...',
    });
  }

  return { subjects: resolverResult.subjects, snapshotDsl };
}
