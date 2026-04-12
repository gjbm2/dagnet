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
  parameterFiles?: Record<string, unknown>,
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

  // Step 2: Extract distinct context key-set groups.
  // All values within one MECE dimension share one hash, so we only
  // need one representative slice per group.
  //
  // Window and cohort temporal modes produce different core_hashes
  // (cohort_mode is part of the signature), but they are NOT competing
  // regimes — they are complementary data for the same epoch.  We
  // collect both representative slices per key-set so Step 3 can
  // compute hashes for both, but they are grouped into ONE candidate
  // regime per key-set (with both hashes as equivalents) so regime
  // selection keeps both.
  const keySetMap = new Map<string, { keys: string[]; representativeSlices: string[] }>();
  for (const slice of explodedSlices) {
    try {
      const parsed = parseConstraints(slice);
      const keys = extractContextKeysFromConstraints(parsed).sort();
      const keySetId = keys.join('||');
      if (!keySetMap.has(keySetId)) {
        keySetMap.set(keySetId, { keys, representativeSlices: [slice] });
      } else {
        // Add this temporal mode's slice if it's a different mode
        const entry = keySetMap.get(keySetId)!;
        const existingModes = new Set(entry.representativeSlices.map(s => {
          try { return parseConstraints(s).cohort ? 'cohort' : 'window'; } catch { return '?'; }
        }));
        const thisMode = parsed.cohort ? 'cohort' : 'window';
        if (!existingModes.has(thisMode)) {
          entry.representativeSlices.push(slice);
        }
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

  for (const [_keySetId, { keys, representativeSlices }] of Array.from(keySetMap.entries())) {
    try {
      // Build fetch plans for ALL representative slices (window + cohort).
      // Collect all core_hashes per edge for this key-set, then emit ONE
      // candidate with the first hash as primary and the rest as equivalents.
      // This prevents regime selection from treating window and cohort as
      // competing regimes — they are complementary temporal modes for the
      // same context epoch.
      const edgeHashes: Record<string, string[]> = {};

      for (const repSlice of representativeSlices) {
        const { plan } = await buildFetchPlanProduction(
          graph as any,
          repSlice,
          dummyWindow,
        );
        if (!plan?.items) continue;

        for (const item of plan.items) {
          if (!item.querySignature || !item.targetId) continue;
          const coreHash = await computeShortCoreHash(item.querySignature);
          if (!edgeHashes[item.targetId]) edgeHashes[item.targetId] = [];
          if (!edgeHashes[item.targetId].includes(coreHash)) {
            edgeHashes[item.targetId].push(coreHash);
          }
        }
      }

      for (const [edgeId, hashes] of Object.entries(edgeHashes)) {
        if (!result[edgeId]) result[edgeId] = [];
        const primaryHash = hashes[0];
        const closureEntries = getClosureSet(primaryHash);
        const equivalentHashes = [
          ...closureEntries.map(e => e.core_hash),
          ...hashes.slice(1),
        ];
        if (!result[edgeId].find(r => r.core_hash === primaryHash)) {
          result[edgeId].push({
            core_hash: primaryHash,
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

  // Step 5: Discover supplementary hash families from stored param file slices.
  // When the current DSL is bare but param files contain context-qualified
  // values[] entries (from previous contexted runs), the DB has data under
  // contexted hashes that Step 3 won't find. Conversely, when the DSL is
  // contexted, historical uncontexted data may exist (covered by Step 4).
  // This step generalises: scan stored slices for ALL key-sets not already
  // covered, compute their hashes, and add as candidate regimes.
  // See programme.md §"Historical DSL epoch hash discovery for Bayes".
  if (parameterFiles && Object.keys(result).length > 0) {
    try {
      const { enumeratePlausibleContextKeySets } = await import('./snapshotRetrievalsService');
      const { extractSliceDimensions } = await import('./sliceIsolation');
      const edges = (graph as any).edges ?? [];

      // Get the bare temporal clause for synthesising contexted DSL slices.
      const firstSlice = explodedSlices[0] || '';
      const bareTemporal = firstSlice
        .replace(/\.?context\([^)]*\)/g, '')
        .replace(/^\./,  '')
        .trim();

      for (const edge of edges) {
        const edgeId = edge.uuid;
        if (!edgeId || !result[edgeId]) continue;

        // Find param file for this edge
        const paramId = edge.p?.id;
        if (!paramId) continue;
        const pf = (parameterFiles[`parameter-${paramId}`] ?? parameterFiles[paramId]) as any;
        if (!pf?.values || !Array.isArray(pf.values)) continue;

        // Discover key-sets from stored slices
        const keySets = enumeratePlausibleContextKeySets({}, pf.values);
        const existingKeySetIds = new Set(
          result[edgeId].map(r => (r.context_keys ?? []).sort().join('||'))
        );

        for (const keys of keySets) {
          const keySetId = keys.sort().join('||');
          if (existingKeySetIds.has(keySetId)) continue;  // already covered

          // Synthesise a DSL slice with these context keys
          let synthSlice = bareTemporal;
          if (keys.length > 0 && synthSlice) {
            const ctxSuffix = keys.map(k => `context(${k})`).join('.');
            // Wrap: (window(...);cohort(...)).context(dim)
            synthSlice = `(${synthSlice}).${ctxSuffix}`;
          }
          if (!synthSlice) continue;

          try {
            const { plan: suppPlan } = await buildFetchPlanProduction(
              graph as any,
              synthSlice,
              dummyWindow,
            );
            if (!suppPlan?.items) continue;

            for (const item of suppPlan.items) {
              if (!item.querySignature || !item.targetId) continue;
              if (item.targetId !== edgeId) continue;

              const coreHash = await computeShortCoreHash(item.querySignature);
              if (result[edgeId].find(r => r.core_hash === coreHash)) continue;

              const closureEntries = getClosureSet(coreHash);
              const equivalentHashes = closureEntries.map(e => e.core_hash);

              result[edgeId].push({
                core_hash: coreHash,
                equivalent_hashes: equivalentHashes,
                context_keys: keys,
              });
              existingKeySetIds.add(keySetId);
            }
          } catch {
            // Non-fatal: skip key-sets that fail to compute
          }
        }
      }
    } catch {
      // Non-fatal: supplementary discovery is best-effort
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
