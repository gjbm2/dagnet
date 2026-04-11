/**
 * Candidate Regime Construction — Doc 30 §4.1
 *
 * Builds the ordered list of candidate hashes per edge and the
 * mece_dimensions list for a graph. These are sent to the BE so it
 * can perform regime selection (pick one hash per retrieved_at date).
 *
 * Candidates are derived from the current pinned DSL (exploded into
 * atomic slices, grouped by context key-set). Each key-set maps to
 * one core_hash. Hash-mapping closures extend each hash's reach.
 *
 * See: docs/current/project-bayes/30-snapshot-regime-selection-contract.md
 */

import type { Graph } from '../types';

export interface CandidateRegime {
  core_hash: string;
  equivalent_hashes: string[];
  /** Context dimension keys that produced this hash (e.g. ['channel']). Empty = bare/uncontexted. */
  context_keys?: string[];
}

/**
 * Build candidate regimes per edge from the graph's pinned DSL.
 *
 * For each edge, explodes the DSL, extracts distinct context key-sets,
 * computes core_hash for each, adds hash-mapping closures.
 *
 * @returns Record<edgeUuid, CandidateRegime[]> — ordered by preference
 *   (more granular first, but ordering doesn't affect correctness for
 *   aggregate queries).
 */
export async function buildCandidateRegimesByEdge(
  graph: Graph,
  workspace: { repository: string; branch: string },
): Promise<Record<string, CandidateRegime[]>> {
  const pinnedDsl = graph.dataInterestsDSL;
  if (!pinnedDsl || typeof pinnedDsl !== 'string' || !pinnedDsl.trim()) {
    return {};
  }

  const { explodeDSL } = await import('../lib/dslExplosion');
  const { parseConstraints } = await import('../lib/queryDSL');
  const { extractContextKeysFromConstraints } = await import('./dataOperations/querySignature');

  // Step 1: Explode pinned DSL into atomic slices
  const explodedSlices = await explodeDSL(pinnedDsl);
  if (explodedSlices.length === 0) return {};

  // Step 2: Extract distinct (context key-set × temporal mode) groups.
  // All values within one MECE dimension share one hash, so we only
  // need one representative slice per group. Temporal mode (window vs
  // cohort) is included because cohort_mode is part of the core hash
  // signature — different modes produce different hashes and must each
  // appear as a candidate regime so regime selection can match DB rows.
  const keySetMap = new Map<string, { keys: string[]; representativeSlice: string }>();
  for (const slice of explodedSlices) {
    try {
      const parsed = parseConstraints(slice);
      const keys = extractContextKeysFromConstraints(parsed).sort();
      const temporalMode = parsed.cohort ? 'cohort' : 'window';
      const keySetId = `${temporalMode}::${keys.join('||')}`;
      if (!keySetMap.has(keySetId)) {
        keySetMap.set(keySetId, { keys, representativeSlice: slice });
      }
    } catch {
      // Skip unparseable slices
    }
  }

  if (keySetMap.size === 0) return {};

  // Step 3: For each key-set, compute signature + core_hash for each edge.
  // Uses the same pipeline as the daily fetch write path.
  const { computeShortCoreHash } = await import('./coreHashService');
  const { getClosureSet } = await import('./hashMappingsService');
  const { buildFetchPlanProduction } = await import('./fetchPlanBuilderService');

  // We need a date range for buildFetchPlanProduction. The dates don't
  // affect the signature (date bounds are stripped before hashing), but
  // the function requires them. Use a dummy 1-day range.
  const { formatDateUK } = await import('../lib/dateFormat');
  const today = formatDateUK(new Date());
  const dummyWindow = { start: today, end: today };

  const result: Record<string, CandidateRegime[]> = {};

  for (const [_keySetId, { keys, representativeSlice }] of Array.from(keySetMap.entries())) {
    try {
      // Build fetch plan for this representative slice to get per-edge signatures
      const { plan } = await buildFetchPlanProduction(
        graph as any,
        representativeSlice,
        dummyWindow,
      );

      if (!plan?.items) continue;

      for (const item of plan.items) {
        if (!item.querySignature) continue;

        const edgeId = item.targetId;
        if (!edgeId) continue;

        const coreHash = await computeShortCoreHash(item.querySignature);
        const closureEntries = getClosureSet(coreHash);
        const equivalentHashes = closureEntries.map(e => e.core_hash);

        if (!result[edgeId]) result[edgeId] = [];

        // Avoid duplicates (same hash from different representative slices)
        const existing = result[edgeId].find(r => r.core_hash === coreHash);
        if (!existing) {
          result[edgeId].push({
            core_hash: coreHash,
            equivalent_hashes: equivalentHashes,
            context_keys: keys,
          });
        }
      }
    } catch {
      // Skip key-sets that fail (e.g., context def not loaded)
    }
  }

  // Step 4: Add bare (uncontexted) regime as fallback for each edge.
  // In mixed-epoch scenarios, early dates may have only uncontexted data
  // under a different core_hash. The bare hash is computed from the same
  // edge structure but without context_def_hashes in the signature.
  if (Object.keys(result).length > 0) {
    try {
      // Strip context from a representative slice to get the bare temporal clause
      const firstSlice = explodedSlices[0] || '';
      const bareSlice = firstSlice
        .replace(/\.?context\([^)]*\)/g, '')
        .replace(/^\./,  '')
        .trim();
      if (bareSlice) {
        const { plan: barePlan } = await buildFetchPlanProduction(
          graph as any,
          bareSlice,
          dummyWindow,
        );
        if (barePlan?.items) {
          for (const item of barePlan.items) {
            if (!item.querySignature || !item.targetId) continue;
            const edgeId = item.targetId;
            const coreHash = await computeShortCoreHash(item.querySignature);
            const closureEntries = getClosureSet(coreHash);
            const equivalentHashes = closureEntries.map(e => e.core_hash);
            if (!result[edgeId]) result[edgeId] = [];
            if (!result[edgeId].find(r => r.core_hash === coreHash)) {
              result[edgeId].push({
                core_hash: coreHash,
                equivalent_hashes: equivalentHashes,
                context_keys: [],
              });
            }
          }
        }
      }
    } catch {
      // Non-fatal: bare regime is a best-effort fallback
    }
  }

  return result;
}

/**
 * Compute the list of MECE dimension names for a graph.
 *
 * Reads the context registry and returns dimension names whose
 * definitions have otherPolicy 'null' or 'computed' — meaning
 * the listed values are exhaustive and safe to aggregate.
 *
 * Only includes dimensions actually mentioned in the graph's
 * pinned DSL (not all dimensions in the registry).
 */
export async function computeMeceDimensions(
  graph: Graph,
  workspace?: { repository: string; branch: string },
): Promise<string[]> {
  const { contextRegistry } = await import('./contextRegistry');

  // Collect context keys from two sources:
  // 1. The pinned DSL (if it mentions contexts)
  // 2. All known context definitions in the registry
  // MECE is a property of the data, not the query — a dimension is MECE
  // regardless of whether the current DSL commissions context slices.
  const allKeys = new Set<string>();

  // Source 1: DSL-mentioned contexts
  const pinnedDsl = graph.dataInterestsDSL;
  if (pinnedDsl && typeof pinnedDsl === 'string' && pinnedDsl.trim()) {
    try {
      const { parseConstraints } = await import('../lib/queryDSL');
      const { extractContextKeysFromConstraints } = await import('./dataOperations/querySignature');
      const { explodeDSL } = await import('../lib/dslExplosion');
      const slices = await explodeDSL(pinnedDsl);
      for (const slice of slices) {
        try {
          const parsed = parseConstraints(slice);
          for (const key of extractContextKeysFromConstraints(parsed)) {
            allKeys.add(key);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // Source 2: All context definitions in the registry cache.
  // In CLI mode these are pre-loaded from disk; in browser mode they
  // accumulate as contexts are fetched. This ensures MECE dimensions
  // are reported even when the DSL doesn't mention contexts.
  for (const key of contextRegistry.getCachedIds(workspace ? { workspace } : undefined)) {
    allKeys.add(key);
  }

  if (allKeys.size === 0) return [];

  // Ensure contexts are cached
  try {
    await contextRegistry.ensureContextsCached(
      Array.from(allKeys),
      workspace ? { workspace } : undefined,
    );
  } catch {
    // best-effort
  }

  // Check each key's MECE status
  const meceDims: string[] = [];
  for (const key of Array.from(allKeys).sort()) {
    const ctx = await contextRegistry.getContext(key, workspace ? { workspace } : undefined);
    if (!ctx) continue;
    const policy = ctx.otherPolicy || 'undefined';
    if (policy === 'null' || policy === 'computed') {
      meceDims.push(key);
    }
  }

  return meceDims;
}

/**
 * Filter candidate regimes per edge to match a scenario's context dimensions.
 *
 * Per doc 30 §4.1: "For a query targeting a specific dimension, the FE
 * filters the candidate list to only hashes whose key-set includes the
 * queried dimension."
 *
 * - Scenario with `context(channel:google)` → keep only regimes with `channel` in key-set
 * - Scenario with no context → keep only bare (uncontexted) regimes (`context_keys = []`)
 * - Scenario with `context(channel:google).context(device:mobile)` → keep only
 *   regimes whose key-set is exactly `['channel', 'device']`
 *
 * If filtering produces an empty list for an edge, there's no data for that
 * scenario's context — the analysis degrades gracefully.
 */
export async function filterCandidatesByContext(
  allRegimes: Record<string, CandidateRegime[]>,
  effectiveQueryDsl: string,
): Promise<Record<string, CandidateRegime[]>> {
  const { parseConstraints } = await import('../lib/queryDSL');
  const { extractContextKeysFromConstraints } = await import('./dataOperations/querySignature');

  const parsed = parseConstraints(effectiveQueryDsl);
  const queryKeys = extractContextKeysFromConstraints(parsed).sort();
  const queryKeySet = queryKeys.join('||');

  const filtered: Record<string, CandidateRegime[]> = {};
  for (const [edgeId, regimes] of Object.entries(allRegimes)) {
    const matching = regimes.filter((r) => {
      const regimeKeys = (r.context_keys || []).sort();
      return regimeKeys.join('||') === queryKeySet;
    });
    if (matching.length > 0) {
      filtered[edgeId] = matching;
    }
  }
  return filtered;
}
