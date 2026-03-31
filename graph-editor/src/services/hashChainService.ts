/**
 * hashChainService — Trace the hash history chain for a parameter.
 *
 * Given a parameter's stored values (each with a query_signature and date
 * range), and the current computed core_hash, determines whether the full
 * history is reachable via hash-mappings.json equivalence links.
 *
 * A break in the chain means some historical snapshot data is orphaned —
 * the system can't find it because no mapping bridges the old hash to
 * the current one.
 *
 * @see docs/current/project-contexts/VARIANT_CONTEXTS_DESIGN.md
 */

import { getClosureSet, getMappings } from './hashMappingsService';
import { computeShortCoreHash } from './coreHashService';
import type { HashMapping } from './hashMappingsService';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HashEpoch {
  /** The core_hash for this epoch (base64url, ~22 chars) */
  coreHash: string;
  /** Earliest date covered by values with this signature */
  earliestDate: string | null;
  /** Latest date covered by values with this signature */
  latestDate: string | null;
  /** Whether this hash is reachable from the current hash via closure */
  reachable: boolean;
}

export interface HashChainResult {
  /** The current core_hash (computed from current definitions) */
  currentHash: string;
  /** All distinct hash epochs found on the parameter's values, oldest first */
  epochs: HashEpoch[];
  /** Whether the full chain is intact (all epochs reachable) */
  chainIntact: boolean;
  /** The earliest reachable date (null if no reachable epochs have dates) */
  earliestReachableDate: string | null;
  /** The earliest unreachable date — where the chain breaks (null if intact) */
  earliestBreakDate: string | null;
  /** Days since the chain break (null if intact) */
  breakAgeDays: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trace the hash history chain for a parameter.
 *
 * @param currentHash - The core_hash computed from current event/context definitions
 * @param parameterValues - The parameter's values array (each may have query_signature and dates)
 * @param mappings - Hash mappings (default: loaded from hash-mappings.json)
 * @returns Chain analysis result
 */
export async function traceHashChain(
  currentHash: string,
  parameterValues: any[],
  mappings?: HashMapping[],
): Promise<HashChainResult> {
  const allMappings = mappings ?? getMappings();

  // Build closure set from current hash — all transitively reachable hashes
  const closure = getClosureSet(currentHash, allMappings);
  const reachableHashes = new Set<string>([
    currentHash,
    ...closure.map(e => e.core_hash),
  ]);

  // Extract distinct hash epochs from parameter values
  const epochMap = new Map<string, { earliest: string | null; latest: string | null }>();

  for (const val of parameterValues) {
    if (!val.query_signature) continue;

    let hash: string;
    try {
      hash = await computeShortCoreHash(val.query_signature);
    } catch {
      continue;
    }

    // Determine date range for this value
    const dates = extractDates(val);
    const existing = epochMap.get(hash);

    if (!existing) {
      epochMap.set(hash, { earliest: dates.earliest, latest: dates.latest });
    } else {
      // Extend the range
      if (dates.earliest && (!existing.earliest || dates.earliest < existing.earliest)) {
        existing.earliest = dates.earliest;
      }
      if (dates.latest && (!existing.latest || dates.latest > existing.latest)) {
        existing.latest = dates.latest;
      }
    }
  }

  // Build sorted epochs (oldest first by earliest date)
  const epochs: HashEpoch[] = Array.from(epochMap.entries())
    .map(([coreHash, range]) => ({
      coreHash,
      earliestDate: range.earliest,
      latestDate: range.latest,
      reachable: reachableHashes.has(coreHash),
    }))
    .sort((a, b) => {
      if (!a.earliestDate && !b.earliestDate) return 0;
      if (!a.earliestDate) return 1;
      if (!b.earliestDate) return -1;
      return a.earliestDate.localeCompare(b.earliestDate);
    });

  const chainIntact = epochs.every(e => e.reachable);

  // Find earliest unreachable epoch
  const unreachable = epochs.filter(e => !e.reachable);
  const earliestBreak = unreachable.length > 0 ? unreachable[0] : null;
  const earliestBreakDate = earliestBreak?.earliestDate ?? null;

  // Find earliest reachable epoch
  const reachable = epochs.filter(e => e.reachable && e.earliestDate);
  const earliestReachableDate = reachable.length > 0 ? reachable[0].earliestDate : null;

  // Compute break age
  let breakAgeDays: number | null = null;
  if (earliestBreakDate) {
    const breakTime = new Date(earliestBreakDate).getTime();
    if (!isNaN(breakTime)) {
      breakAgeDays = Math.floor((Date.now() - breakTime) / (24 * 60 * 60 * 1000));
    }
  }

  return {
    currentHash,
    epochs,
    chainIntact,
    earliestReachableDate,
    earliestBreakDate,
    breakAgeDays,
  };
}

/**
 * Extract the earliest and latest dates from a parameter value.
 * Checks window_from/to, cohort_from/to, and data_source.retrieved_at.
 */
function extractDates(val: any): { earliest: string | null; latest: string | null } {
  const candidates: string[] = [];

  if (val.window_from) candidates.push(val.window_from);
  if (val.window_to) candidates.push(val.window_to);
  if (val.cohort_from) candidates.push(val.cohort_from);
  if (val.cohort_to) candidates.push(val.cohort_to);
  if (val.data_source?.retrieved_at) candidates.push(val.data_source.retrieved_at);
  if (val.evidence?.window_from) candidates.push(val.evidence.window_from);
  if (val.evidence?.window_to) candidates.push(val.evidence.window_to);

  // Filter to valid date strings and sort
  const valid = candidates.filter(d => d && !isNaN(new Date(d).getTime()));
  if (valid.length === 0) return { earliest: null, latest: null };

  valid.sort();
  return { earliest: valid[0], latest: valid[valid.length - 1] };
}
