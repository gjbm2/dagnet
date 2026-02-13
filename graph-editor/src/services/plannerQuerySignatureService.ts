/**
 * Planner Query Signature Service
 *
 * Purpose:
 * - Compute the SAME query_signature as the executor (DataOperationsService) would compute,
 *   but for planner analysis (cache coverage / signature isolation).
 *
 * Key property:
 * - Uses `buildDslFromEdge` (real queryPayload construction) + `computeQuerySignature` (real hashing),
 *   so signatures match what gets persisted in parameter files.
 *
 * Notes:
 * - This is async and may load event/context definitions via FileRegistry / ContextRegistry.
 * - This MUST NOT perform any HTTP or file writes.
 */

import type { Graph } from '../types';
import { parseConstraints } from '../lib/queryDSL';
import { fileRegistry } from '../contexts/TabContext';
import { buildItemKey } from './fetchPlanTypes';
import { enumerateFetchTargets } from './fetchTargetEnumerationService';
import { computeQuerySignature } from './dataOperationsService';
import { formatDateUK } from '../lib/dateFormat';
import { parseUKDate } from '../lib/dateFormat';
import { selectPersistedProbabilityConfig } from './persistedParameterConfigService';
import { resolveMECEPartitionForImplicitUncontextedSync } from './meceSliceService';
import { isCohortModeValue } from './windowAggregationService';
import { extractSliceDimensions } from './sliceIsolation';
import type { ParameterValue } from '../types/parameterData';
import { isSignatureCheckingEnabled } from './signaturePolicyService';
import { sessionLogService } from './sessionLogService';

type ParamSlot = 'p' | 'cost_gbp' | 'labour_cost';

function extractContextKeysFromConstraints(constraints?: {
  context?: Array<{ key: string }>;
  contextAny?: Array<{ pairs: Array<{ key: string }> }>;
} | null): string[] {
  if (!constraints) return [];
  const keys = new Set<string>();
  for (const ctx of constraints.context || []) {
    if (ctx?.key) keys.add(ctx.key);
  }
  for (const ctxAny of constraints.contextAny || []) {
    for (const pair of ctxAny?.pairs || []) {
      if (pair?.key) keys.add(pair.key);
    }
  }
  return Array.from(keys).sort();
}

function resolveOpenEndedWindowsInConstraints(constraints: any): any {
  // Mirror the executor behaviour: open-ended window/cohort ranges are valid but must be normalised
  // to avoid silent fallbacks in downstream logic.
  const todayUK = formatDateUK(new Date());
  const next = { ...constraints };
  if (next.window?.start && !next.window.end) next.window = { ...next.window, end: todayUK };
  if (next.cohort?.start && !next.cohort.end) next.cohort = { ...next.cohort, end: todayUK };
  return next;
}

function toISOFromUKOrISO(ukOrIso: string | undefined): string | undefined {
  if (!ukOrIso) return undefined;
  // If it looks like a UK date, convert to ISO. Otherwise assume it is already ISO-ish.
  // (External boundaries may use ISO; internal UI should use UK date strings.)
  try {
    return parseUKDate(ukOrIso).toISOString();
  } catch {
    const d = new Date(ukOrIso);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return undefined;
  }
}

export async function computePlannerQuerySignaturesForGraph(input: {
  graph: Graph;
  dsl: string;
  /** Bypass the isSignatureCheckingEnabled() guard. Used by snapshot analysis share
   *  flows that need core_hash even when signature checking is off at the policy level. */
  forceCompute?: boolean;
}): Promise<Record<string, string>> {
  const { graph, dsl, forceCompute } = input;

  // RELEASE SAFETY: signature checking is disabled, so planner signature computation is unnecessary.
  // Exception: forceCompute bypasses this for snapshot DB lookups in share flows.
  if (!forceCompute && !isSignatureCheckingEnabled()) return {};

  // Resolve providers for connections (cache to avoid repeated YAML reads).
  const providerByConnection = new Map<string, string>();
  const getProvider = async (connectionName: string): Promise<string | undefined> => {
    if (providerByConnection.has(connectionName)) return providerByConnection.get(connectionName);
    try {
      const { createDASRunner } = await import('../lib/das');
      const runner = createDASRunner();
      const conn = await (runner as any).connectionProvider.getConnection(connectionName);
      const provider = conn?.provider;
      if (provider) providerByConnection.set(connectionName, provider);
      return provider;
    } catch {
      // Test/diagnostic fallback: allow deterministic inference when the connection registry
      // isn't reachable (e.g. Vitest environment).
      //
      // This does NOT affect executor behaviour; it only enables planner signature computation
      // to be exercised in integration tests.
      const lower = String(connectionName).toLowerCase();
      const inferred =
        lower.includes('amplitude') ? 'amplitude'
        : lower.includes('sheets') || lower.includes('google') ? 'sheets'
        : lower.includes('statsig') ? 'statsig'
        : lower.includes('optimizely') ? 'optimizely'
        : undefined;
      if (inferred) {
        providerByConnection.set(connectionName, inferred);
      }
      return inferred;
    }
  };

  const eventLoader = async (eventId: string) => {
    const fileId = `event-${eventId}`;
    let file = fileRegistry.getFile(fileId);
    if (!file) {
      try {
        await fileRegistry.restoreFile(fileId);
        file = fileRegistry.getFile(fileId);
      } catch {
        // ignore
      }
    }
    return (
      file?.data ?? {
        id: eventId,
        name: eventId,
        provider_event_names: {},
      }
    );
  };

  // Parse the graph-level DSL once (will be merged per-edge with edge query constraints).
  let graphConstraints: any = null;
  try {
    graphConstraints = dsl ? parseConstraints(dsl) : null;
  } catch {
    graphConstraints = null;
  }

  const dslTargetDims = extractSliceDimensions(dsl);
  const dslHasAnyContext =
    (graphConstraints?.context && graphConstraints.context.length > 0) ||
    (graphConstraints?.contextAny && graphConstraints.contextAny.length > 0);
  const dslIsCohort = typeof dsl === 'string' && dsl.includes('cohort(');

  const out: Record<string, string> = {};
  const targets = enumerateFetchTargets(graph as any);

  for (const t of targets) {
    if (t.type !== 'parameter') continue;

    const targetId = t.targetId;
    const edge = (graph as any).edges?.find((e: any) => e?.uuid === targetId || e?.id === targetId);
    if (!edge) continue;

    const slot = (t as any).paramSlot as ParamSlot | undefined;
    const conditionalIndex = (t as any).conditionalIndex as number | undefined;

    const paramObj =
      conditionalIndex !== undefined
        ? edge?.conditional_p?.[conditionalIndex]?.p
        : slot
          ? edge?.[slot]
          : undefined;

    // IMPORTANT: Match executor behaviour: in versioned mode, we may prefer persisted parameter-file config
    // (connection, connection_string, latency, etc.) over graph state.
    const paramFile = (() => {
      const fileId = `parameter-${t.objectId}`;
      return fileRegistry.getFile(fileId);
    })();
    const persistedCfg = selectPersistedProbabilityConfig({
      writeToFile: true,
      fileParamData: paramFile?.data,
      graphParam: paramObj,
      graphEdge: edge,
    });

    const connectionName: string | undefined = persistedCfg.connection ?? paramObj?.connection ?? input.graph.defaultConnection;
    if (!connectionName) continue;

    // Use the effective query string (conditional overrides base).
    const effectiveQuery =
      conditionalIndex !== undefined && edge?.conditional_p?.[conditionalIndex]?.query
        ? edge.conditional_p[conditionalIndex].query
        : edge?.query;

    if (!effectiveQuery) continue;

    // Merge constraints exactly like executor: graph-level (dsl) + edge-level (query)
    let edgeConstraints: any = null;
    try {
      edgeConstraints = parseConstraints(effectiveQuery);
    } catch {
      edgeConstraints = null;
    }

    const merged = resolveOpenEndedWindowsInConstraints({
      context: [...(graphConstraints?.context || []), ...(edgeConstraints?.context || [])],
      contextAny: [...(graphConstraints?.contextAny || []), ...(edgeConstraints?.contextAny || [])],
      window: edgeConstraints?.window || graphConstraints?.window || null,
      cohort: edgeConstraints?.cohort || graphConstraints?.cohort || null,
      visited: edgeConstraints?.visited || [],
      visitedAny: edgeConstraints?.visitedAny || [],
    });

    // Signature context keys:
    // - Always include explicit context keys present in the DSL/query (as the executor does).
    //
    // For implicit-uncontexted fulfilment over contexted MECE cache:
    // - The planner must consider **multiple** possible signatures, one per candidate context key,
    //   because the cached slices are signed with the context *definition* hash of the MECE key,
    //   while the uncontexted DSL itself contains no context clause.
    //
    // This is the production failure mode: cache is "COVERED (FULL headers)" but signature isolation
    // rejects it because planner only checked the uncontexted signature.
    const baseSignatureContextKeys = extractContextKeysFromConstraints(merged);
    const candidateContextKeys: string[] = [];
    try {
      if (!dslHasAnyContext && dslTargetDims === '' && paramFile?.data?.values) {
        const allValues = paramFile.data.values as ParameterValue[];
        const modeFilteredValues = allValues.filter((v) => {
          if (dslIsCohort) return isCohortModeValue(v);
          return !isCohortModeValue(v);
        });
        const hasAnyContexted = modeFilteredValues.some(v => extractSliceDimensions(v.sliceDSL ?? '') !== '');
        if (hasAnyContexted) {
          // Best-effort: ensure contexts are cached so MECE detection is not "unknown".
          // We only need keys that are present in the file values.
          const keysInFile = new Set<string>();
          for (const v of modeFilteredValues) {
            const dims = extractSliceDimensions(v.sliceDSL ?? '');
            if (!dims) continue;
            try {
              const parsedDims = parseConstraints(dims);
              for (const c of parsedDims.context) keysInFile.add(c.key);
              for (const group of parsedDims.contextAny) {
                for (const pair of group.pairs) keysInFile.add(pair.key);
              }
            } catch {
              // ignore
            }
          }
          if (keysInFile.size > 0) {
            try {
              // Workspace scope: pull from the parameter file source if present.
              const repo = (paramFile as any)?.source?.repository;
              const branch = (paramFile as any)?.source?.branch;
              const workspace = repo && branch ? { repository: repo, branch } : undefined;
              const { contextRegistry } = await import('./contextRegistry');
              await contextRegistry.ensureContextsCached(
                Array.from(keysInFile),
                workspace ? { workspace } : undefined
              );
            } catch {
              // ignore
            }
          }

          // Candidate set: any context keys that appear in the cached file values are plausible
          // MECE fulfilment keys (and are also drawn from the same workspace context universe
          // that backs the "+ Context" dropdown).
          for (const k of Array.from(keysInFile.values()).sort()) {
            candidateContextKeys.push(k);
          }
        }
      }
    } catch (err) {
      // Warn but continue: context caching is best-effort enhancement
      sessionLogService.warning(
        'data-fetch',
        'PLANNER_SIG_CONTEXT_CACHE_FAILED',
        `Failed to cache contexts for signature computation: ${t.objectId}`,
        undefined,
        { objectId: t.objectId, targetId: t.targetId, error: String(err) }
      );
    }

    const provider = await getProvider(connectionName);
    if (!provider) {
      sessionLogService.warning(
        'data-fetch',
        'PLANNER_SIG_NO_PROVIDER',
        `Cannot compute signature for ${t.objectId}: no provider for connection "${connectionName}"`,
        undefined,
        { objectId: t.objectId, targetId: t.targetId, connectionName }
      );
      continue;
    }

    // Build the same queryPayload as execution would.
    try {
      const { buildDslFromEdge } = await import('../lib/das/buildDslFromEdge');

      // Ensure the edge object we pass matches the effective query and the correct param slot,
      // and includes persisted config overrides (mirrors executor's edgeForDsl).
      const edgeForDsl = {
        ...edge,
        query: effectiveQuery,
        p: paramObj
          ? {
              ...paramObj,
              ...(persistedCfg.source === 'file' && persistedCfg.connection ? { connection: persistedCfg.connection } : {}),
              ...(persistedCfg.source === 'file' && persistedCfg.connection_string ? { connection_string: persistedCfg.connection_string } : {}),
              ...(persistedCfg.source === 'file' && persistedCfg.latency ? { latency: persistedCfg.latency } : {}),
            }
          : paramObj,
      };

      const buildResult = await buildDslFromEdge(edgeForDsl, graph as any, provider, eventLoader, merged);
      const queryPayload = buildResult.queryPayload;

      // Ensure payload has explicit ISO window/cohort bounds if present in merged constraints.
      // (Signatures intentionally exclude bounds, but downstream code expects stable payload shape.)
      if (merged.window?.start || merged.window?.end) {
        const startIso = toISOFromUKOrISO(merged.window?.start);
        const endIso = toISOFromUKOrISO(merged.window?.end);
        if (startIso) (queryPayload as any).start = startIso;
        if (endIso) (queryPayload as any).end = endIso;
      }
      if (merged.cohort?.start || merged.cohort?.end) {
        const startIso = toISOFromUKOrISO(merged.cohort?.start);
        const endIso = toISOFromUKOrISO(merged.cohort?.end);
        (queryPayload as any).cohort = {
          ...(queryPayload as any).cohort,
          start: startIso,
          end: endIso,
        };
      }

      const itemKey = buildItemKey({
        type: 'parameter',
        objectId: t.objectId,
        targetId: t.targetId,
        slot: slot,
        conditionalIndex,
      });

      const workspaceForSignature = (() => {
        const repo = (paramFile as any)?.source?.repository;
        const branch = (paramFile as any)?.source?.branch;
        return repo && branch ? { repository: repo, branch } : undefined;
      })();

      // Merge DSL-explicit context keys with candidate keys discovered from cached
      // parameter file values.  The executor (dataOperationsService) always includes
      // context keys via the per-slice targetSlice DSL, so the planner must do the
      // same — otherwise the signature (and therefore core_hash) will diverge from
      // what was written to the snapshot DB, causing lookup failures.
      const effectiveContextKeys = [
        ...new Set([...baseSignatureContextKeys, ...candidateContextKeys]),
      ].sort();
      const sig = await computeQuerySignature(
        queryPayload,
        connectionName,
        graph as any,
        edgeForDsl,
        effectiveContextKeys,
        workspaceForSignature,
        buildResult.eventDefinitions  // Pass event definitions for hashing
      );
      out[itemKey] = sig;
    } catch (err) {
      // CRITICAL: Signature computation failed - this item will use header-only coverage (no signature isolation).
      // This is a potential cache validity issue that MUST be visible.
      sessionLogService.warning(
        'data-fetch',
        'PLANNER_SIG_COMPUTATION_FAILED',
        `Signature computation failed for ${t.objectId}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        {
          objectId: t.objectId,
          targetId: t.targetId,
          connectionName,
          effectiveQuery,
          error: err instanceof Error ? err.message : String(err),
        }
      );
      continue;
    }
  }

  return out;
}


