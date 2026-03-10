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
import { enumerateFetchTargets } from './fetchTargetEnumerationService';
import { fileRegistry } from '../contexts/TabContext';
import { db } from '../db/appDatabase';
import { logSnapshotBoot } from '../lib/snapshotBootTrace';
import { parseConstraints } from '../lib/queryDSL';

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

export interface SnapshotPlannerInputsStatusResult {
  ready: boolean;
  requiredFileIds: string[];
  missingFileIds: string[];
  hydratableFileIds: string[];
  unavailableFileIds: string[];
}

/**
 * Snapshot planning depends on parameter/case/event/context artefacts being present
 * in FileRegistry. Signature computation needs ALL of these: parameter files for
 * values, event files for provider_event_names (used in core_hash), and context files
 * for MECE slice detection.
 *
 * This is a pure readiness check: it does not mutate FileRegistry or trigger hydration.
 */
export async function getSnapshotPlannerInputsStatus(args: {
  scenarioGraph: any;
  workspace?: { repository: string; branch: string };
  /** DSL strings to parse for context key dependencies (analytics DSL, scenario DSL, etc.) */
  dslStrings?: string[];
}): Promise<SnapshotPlannerInputsStatusResult> {
  const allRequired = new Set<string>();

  // 1. Parameter + case files (existing logic via enumerateFetchTargets)
  const targets = enumerateFetchTargets(args.scenarioGraph);
  for (const t of targets) allRequired.add(`${t.type}-${t.objectId}`);

  // 2. Event files — every node with an event_id produces event-{event_id}
  const nodes: any[] = args.scenarioGraph?.nodes || [];
  for (const node of nodes) {
    if (node.event_id) allRequired.add(`event-${node.event_id}`);
  }

  // 3. Context files — extracted from DSL context() / contextAny() clauses
  const edges: any[] = args.scenarioGraph?.edges || [];
  const dslSources = [...(args.dslStrings || [])];
  for (const edge of edges) {
    if (edge.query) dslSources.push(edge.query);
  }
  for (const dslStr of dslSources) {
    if (!dslStr) continue;
    try {
      const parsed = parseConstraints(dslStr);
      for (const ctx of parsed.context || []) {
        if (ctx?.key) allRequired.add(`context-${ctx.key}`);
      }
      for (const ctxAny of parsed.contextAny || []) {
        for (const pair of ctxAny?.pairs || []) {
          if (pair?.key) allRequired.add(`context-${pair.key}`);
        }
      }
    } catch {
      // Unparseable DSL — skip context extraction for this string
    }
  }

  const requiredFileIds = Array.from(allRequired);
  const missingFileIds: string[] = [];
  const hydratableFileIds: string[] = [];
  const unavailableFileIds: string[] = [];

  const hasFileInDb = async (fileId: string): Promise<boolean> => {
    if (await db.files.get(fileId)) return true;
    if (args.workspace) {
      const prefixedId = `${args.workspace.repository}-${args.workspace.branch}-${fileId}`;
      if (await db.files.get(prefixedId)) return true;
    }
    return false;
  };

  logSnapshotBoot('SnapshotPlannerInputs:check-start', {
    requiredFileIds,
    requiredCount: requiredFileIds.length,
  });

  for (const fileId of requiredFileIds) {
    if (fileRegistry.getFile(fileId)) continue;
    missingFileIds.push(fileId);
    if (await hasFileInDb(fileId)) {
      hydratableFileIds.push(fileId);
    } else {
      unavailableFileIds.push(fileId);
    }
  }

  const ready = missingFileIds.length === 0;
  logSnapshotBoot('SnapshotPlannerInputs:check-finish', {
    ready,
    hydratableFileIds,
    missingFileIds,
    unavailableFileIds,
  });
  return {
    ready,
    requiredFileIds,
    missingFileIds,
    hydratableFileIds,
    unavailableFileIds,
  };
}

export async function hydrateSnapshotPlannerInputs(args: {
  fileIds: string[];
  workspace?: { repository: string; branch: string };
}): Promise<void> {
  for (const fileId of args.fileIds) {
    if (fileRegistry.getFile(fileId)) continue;
    try {
      await fileRegistry.restoreFile(fileId, args.workspace);
    } catch {
      // Best effort only; readiness will remain blocked until the file is available.
    }
  }
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

  logSnapshotBoot('SnapshotResolution:start', {
    scenarioId,
    analysisType,
    analyticsDsl,
    scenarioQueryDsl,
    workspace,
  });

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

  logSnapshotBoot('SnapshotResolution:subjects-ready', {
    scenarioId,
    analysisType,
    subjectCount: resolverResult.subjects.length,
    skippedCount: resolverResult.skipped.length,
  });

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
