/**
 * MECE Slice Service
 *
 * Centralises selection of a MECE partition of context slices for "implicit uncontexted" behaviour.
 *
 * Principles:
 * - MECE status is user-declared via context definitions (otherPolicy); we do not attempt to certify overlap.
 * - We only support implicit-uncontexted aggregation when slices vary by exactly ONE context key.
 * - If multiple context keys appear (or case dims are present), we refuse to synthesise an uncontexted total.
 */
import type { ParameterValue } from '../types/parameterData';
import { contextRegistry } from './contextRegistry';
import { parseConstraints } from '../lib/queryDSL';
import { extractSliceDimensions } from './sliceIsolation';
import { parseDate } from './windowAggregationService';

export type MECEResolution =
  | {
      kind: 'explicit_uncontexted_present';
    }
  | {
      kind: 'mece_partition';
      /** Context key we are aggregating across (e.g. channel) */
      key: string;
      /** Whether the partition is complete for the key's declared expected values */
      isComplete: boolean;
      /** Whether the context policy permits treating this as a safe implicit total */
      canAggregate: boolean;
      missingValues: string[];
      /** Selected values to aggregate across (filtered to the chosen key group) */
      values: ParameterValue[];
      /** Any additional non-blocking advisory warnings */
      warnings: string[];
    }
  | {
      kind: 'not_resolvable';
      reason: string;
      warnings: string[];
    };

function hasUncontextedSlice(values: ParameterValue[]): boolean {
  return values.some((v) => extractSliceDimensions(v.sliceDSL ?? '') === '');
}

export function parameterValueRecencyMs(v: ParameterValue): number {
  const ra = v.data_source?.retrieved_at;
  if (typeof ra === 'string' && ra.trim()) {
    const t = new Date(ra).getTime();
    if (!Number.isNaN(t)) return t;
  }
  const bound = v.cohort_to || v.window_to || v.cohort_from || v.window_from;
  if (typeof bound === 'string' && bound.trim()) {
    try {
      const t = parseDate(bound).getTime();
      if (!Number.isNaN(t)) return t;
    } catch {
      // ignore
    }
  }
  return 0;
}

export type MECEResolutionOptions = {
  /**
   * If true, prefer a complete MECE partition over an explicit uncontexted slice when both exist.
   *
   * Rationale: explicit uncontexted slices can be stale or computed under different query signatures,
   * and mixing them with contexted slices across scenarios can produce inconsistent totals.
   */
  preferMECEWhenAvailable?: boolean;
  /**
   * If true, only return a MECE partition when it is complete and aggregatable.
   * (This is the safe default for "treat as total population".)
   */
  requireComplete?: boolean;
};

function isEligibleContextOnlySlice(value: ParameterValue): { key: string; value: string } | null {
  const dsl = value.sliceDSL ?? '';
  const dims = extractSliceDimensions(dsl);
  if (!dims) return null;
  // Reject if case dims are present (implicit uncontexted is only for uncontexted queries).
  // Case dims appear in slice dimensions via sliceIsolation; be conservative and refuse.
  if (dims.includes('case(')) return null;
  const parsed = parseConstraints(dims);
  if (parsed.contextAny.length > 0) return null;
  if (parsed.context.length !== 1) return null;
  return { key: parsed.context[0].key, value: parsed.context[0].value };
}

export type MECEPartitionCandidate = {
  key: string;
  isComplete: boolean;
  canAggregate: boolean;
  missingValues: string[];
  values: ParameterValue[];
  warnings: string[];
  policy: string;
};

export type ImplicitUncontextedSelection =
  | {
      kind: 'explicit_uncontexted';
      values: [ParameterValue];
      diagnostics: {
        /** Milliseconds since epoch (derived from data_source.retrieved_at when available). */
        uncontextedRecencyMs: number;
        /** Whether any MECE candidate existed (even if it lost). */
        hasMECECandidate: boolean;
        /** Milliseconds since epoch for the chosen MECE candidate set, if any (set freshness = stalest member). */
        meceRecencyMs: number | null;
        meceKey: string | null;
        meceQuerySignature: string | null;
        /** Counts of raw candidates present (before dedupe). */
        counts: {
          uncontextedCandidates: number;
          meceEligibleCandidates: number;
          meceGenerationsConsidered: number;
        };
        warnings: string[];
      };
    }
  | {
      kind: 'mece_partition';
      key: string;
      /** The chosen generation’s query signature. Null means legacy/un-signed generation. */
      querySignature: string | null;
      values: ParameterValue[];
      diagnostics: {
        uncontextedRecencyMs: number | null;
        meceRecencyMs: number;
        counts: {
          uncontextedCandidates: number;
          meceEligibleCandidates: number;
          meceGenerationsConsidered: number;
        };
        warnings: string[];
      };
    }
  | {
      kind: 'not_resolvable';
      reason: string;
      diagnostics: {
        uncontextedRecencyMs: number | null;
        meceRecencyMs: number | null;
        meceKey: string | null;
        meceQuerySignature: string | null;
        counts: {
          uncontextedCandidates: number;
          meceEligibleCandidates: number;
          meceGenerationsConsidered: number;
        };
        warnings: string[];
      };
    };

type MECEGenerationCandidate = {
  key: string;
  querySignature: string | null;
  values: ParameterValue[]; // deduped per context value
  mece: { isComplete: boolean; canAggregate: boolean; missingValues: string[]; policy: string };
  warnings: string[];
  recencyMs: number; // set freshness = min recency across members
};

function normaliseQuerySignature(sig: unknown): string | null {
  if (typeof sig !== 'string') return null;
  const s = sig.trim();
  return s ? s : null;
}

function dedupeBySliceDimsMostRecent(values: ParameterValue[]): ParameterValue[] {
  const byDims = new Map<string, ParameterValue>();
  for (const v of values) {
    const dims = extractSliceDimensions(v.sliceDSL ?? '');
    const existing = byDims.get(dims);
    if (!existing) {
      byDims.set(dims, v);
      continue;
    }
    if (parameterValueRecencyMs(v) > parameterValueRecencyMs(existing)) {
      byDims.set(dims, v);
    }
  }
  return Array.from(byDims.values());
}

function computeMECEGenerationCandidates(
  candidateValues: ParameterValue[],
  options?: { requireComplete?: boolean }
): { candidates: MECEGenerationCandidate[]; warnings: string[]; meceEligibleCandidates: number; meceGenerationsConsidered: number } {
  const requireComplete = options?.requireComplete !== false;

  // Extract eligible (single-key) context slices and group by (key, query_signature).
  const eligible: Array<{ pv: ParameterValue; key: string; value: string; sig: string | null }> = [];
  const warnings: string[] = [];

  for (const pv of candidateValues) {
    const ctx = isEligibleContextOnlySlice(pv);
    if (!ctx) continue;
    eligible.push({ pv, key: ctx.key, value: ctx.value, sig: normaliseQuerySignature((pv as any).query_signature) });
  }

  const meceEligibleCandidates = eligible.length;

  // Group into generations. Within each generation, dedupe per context value to the most recent entry.
  const byGeneration = new Map<string, { key: string; sig: string | null; byValue: Map<string, ParameterValue> }>();
  for (const e of eligible) {
    const genKey = `${e.key}||${e.sig ?? '__legacy__'}`;
    const entry = byGeneration.get(genKey) ?? { key: e.key, sig: e.sig, byValue: new Map<string, ParameterValue>() };
    const existingForValue = entry.byValue.get(e.value);
    if (!existingForValue || parameterValueRecencyMs(e.pv) > parameterValueRecencyMs(existingForValue)) {
      entry.byValue.set(e.value, e.pv);
    }
    byGeneration.set(genKey, entry);
  }

  const meceGenerationsConsidered = byGeneration.size;

  const out: MECEGenerationCandidate[] = [];
  for (const gen of byGeneration.values()) {
    const pvs = Array.from(gen.byValue.values());
    const valuesPresent = Array.from(new Set(pvs.map((pv) => {
      const ctx = isEligibleContextOnlySlice(pv);
      return ctx ? ctx.value : '';
    }).filter(Boolean)));
    const mockWindows = valuesPresent.map((v) => ({ sliceDSL: `context(${gen.key}:${v})` }));
    const raw = contextRegistry.detectMECEPartitionSync(mockWindows, gen.key);
    const meceCheck =
      raw.policy === 'unknown'
        // Degrade gracefully: if context definition is not loaded, assume the pinned slice set is intended
        // to be MECE. This matches existing behaviour and allows cache/coverage logic to function in tests
        // and in environments where the context registry is not hydrated.
        ? { isMECE: true, isComplete: true, canAggregate: true, missingValues: [] as string[], policy: 'unknown' }
        : raw;

    if (!meceCheck.isMECE) continue;
    if (!meceCheck.canAggregate) continue;
    if (requireComplete && !meceCheck.isComplete) continue;

    // Dataset freshness = stalest member
    const recencyMs =
      pvs.length > 0
        ? pvs.reduce((min, cur) => Math.min(min, parameterValueRecencyMs(cur)), Number.POSITIVE_INFINITY)
        : Number.NEGATIVE_INFINITY;

    const genWarnings: string[] = [];
    if (meceCheck.policy === 'unknown') {
      genWarnings.push(`Context '${gen.key}' definition not loaded; assuming MECE for implicit uncontexted aggregation`);
    }
    if (!meceCheck.isComplete && meceCheck.missingValues.length > 0) {
      genWarnings.push(`Incomplete MECE partition for '${gen.key}': missing ${meceCheck.missingValues.join(', ')}`);
    }

    out.push({
      key: gen.key,
      querySignature: gen.sig,
      values: dedupeBySliceDimsMostRecent(pvs),
      mece: meceCheck,
      warnings: genWarnings,
      recencyMs: Number.isFinite(recencyMs) ? recencyMs : 0,
    });
  }

  return { candidates: out, warnings, meceEligibleCandidates, meceGenerationsConsidered };
}

/**
 * Select the slice-set to fulfil an implicit uncontexted query (dims == '').
 *
 * Hardening vs the original implementation:
 * - Dedupes explicit uncontexted candidates (choose the most recent entry).
 * - Selects a coherent MECE generation keyed by (MECE key + query_signature), avoiding cross-generation mixing.
 * - Within a chosen MECE generation, dedupes per context value + per slice dims to avoid duplicate entries.
 *
 * Selection rule:
 * - Compare recency: explicit uncontexted recency = max(retrieved_at) of uncontexted candidates,
 *   MECE recency = min(retrieved_at) across slices in the chosen MECE set (set freshness = stalest member).
 * - Pick the higher recency dataset; tie-breaker prefers MECE (determinism and “context transparent iff MECE” intuition).
 */
export function selectImplicitUncontextedSliceSetSync(args: {
  candidateValues: ParameterValue[];
  requireCompleteMECE?: boolean;
}): ImplicitUncontextedSelection {
  const { candidateValues } = args;
  const requireCompleteMECE = args.requireCompleteMECE !== false;

  const warnings: string[] = [];

  const uncontextedCandidatesRaw = candidateValues.filter((v) => extractSliceDimensions(v.sliceDSL ?? '') === '');
  const bestUncontexted =
    uncontextedCandidatesRaw.length > 0
      ? uncontextedCandidatesRaw.reduce((best, cur) => (parameterValueRecencyMs(cur) > parameterValueRecencyMs(best) ? cur : best))
      : undefined;
  const uncontextedRecencyMs = bestUncontexted ? parameterValueRecencyMs(bestUncontexted) : 0;

  const meceGen = computeMECEGenerationCandidates(candidateValues, { requireComplete: requireCompleteMECE });
  const meceCandidates = meceGen.candidates;

  // Pick best MECE generation by recency (newest set wins). Tie-breaker: prefer the set with more slices.
  const bestMECE =
    meceCandidates.length > 0
      ? meceCandidates.reduce((best, cur) => {
          if (cur.recencyMs > best.recencyMs) return cur;
          if (cur.recencyMs < best.recencyMs) return best;
          if (cur.values.length > best.values.length) return cur;
          // Deterministic final tie-breaker: key then signature lexicographically
          const bestSig = best.querySignature ?? '';
          const curSig = cur.querySignature ?? '';
          const k = cur.key.localeCompare(best.key);
          if (k !== 0) return k < 0 ? cur : best;
          return curSig.localeCompare(bestSig) < 0 ? cur : best;
        })
      : undefined;

  const hasMECECandidate = !!bestMECE;
  const meceRecencyMs = bestMECE ? bestMECE.recencyMs : null;

  const counts = {
    uncontextedCandidates: uncontextedCandidatesRaw.length,
    meceEligibleCandidates: meceGen.meceEligibleCandidates,
    meceGenerationsConsidered: meceGen.meceGenerationsConsidered,
  };

  if (bestMECE?.warnings?.length) warnings.push(...bestMECE.warnings);

  // Tie-breaker prefers MECE when recency is equal.
  const chooseMECE =
    !!bestMECE && (uncontextedCandidatesRaw.length === 0 || (meceRecencyMs ?? Number.NEGATIVE_INFINITY) >= uncontextedRecencyMs);

  if (chooseMECE) {
    return {
      kind: 'mece_partition',
      key: bestMECE!.key,
      querySignature: bestMECE!.querySignature,
      values: bestMECE!.values,
      diagnostics: {
        uncontextedRecencyMs: uncontextedCandidatesRaw.length > 0 ? uncontextedRecencyMs : null,
        meceRecencyMs: bestMECE!.recencyMs,
        counts,
        warnings,
      },
    };
  }

  if (bestUncontexted) {
    return {
      kind: 'explicit_uncontexted',
      values: [bestUncontexted],
      diagnostics: {
        uncontextedRecencyMs,
        hasMECECandidate,
        meceRecencyMs,
        meceKey: bestMECE?.key ?? null,
        meceQuerySignature: bestMECE?.querySignature ?? null,
        counts,
        warnings,
      },
    };
  }

  return {
    kind: 'not_resolvable',
    reason: 'No explicit uncontexted slice and no complete MECE partition available',
    diagnostics: {
      uncontextedRecencyMs: null,
      meceRecencyMs,
      meceKey: bestMECE?.key ?? null,
      meceQuerySignature: bestMECE?.querySignature ?? null,
      counts,
      warnings,
    },
  };
}

function computeBestMECEPartitionCandidate(
  candidateValues: ParameterValue[]
):
  | {
      best: { key: string; mece: { isComplete: boolean; canAggregate: boolean; missingValues: string[]; policy: string }; pvs: ParameterValue[] };
      warnings: string[];
      keysPresent: string[];
      ineligibleDims: string[];
    }
  | null {
  // Extract eligible (single-key) context slices.
  const eligible: Array<{ pv: ParameterValue; key: string; value: string }> = [];
  const ineligibleDims = new Set<string>();

  for (const pv of candidateValues) {
    const dims = extractSliceDimensions(pv.sliceDSL ?? '');
    if (!dims) continue;
    const parsedDims = parseConstraints(dims);
    const hasAnyCase = dims.includes('case(') || (parsedDims as any).case?.length > 0;
    if (hasAnyCase) {
      ineligibleDims.add(dims);
      continue;
    }
    const ctx = isEligibleContextOnlySlice(pv);
    if (!ctx) {
      ineligibleDims.add(dims);
      continue;
    }
    eligible.push({ pv, key: ctx.key, value: ctx.value });
  }

  const keysPresent = Array.from(new Set(eligible.map((e) => e.key)));
  if (keysPresent.length === 0) return null;

  // Group eligible slices by context key and evaluate which key forms a usable MECE partition.
  const byKey = new Map<string, { values: Set<string>; pvs: ParameterValue[] }>();
  for (const e of eligible) {
    const entry = byKey.get(e.key) ?? { values: new Set<string>(), pvs: [] };
    entry.values.add(e.value);
    entry.pvs.push(e.pv);
    byKey.set(e.key, entry);
  }

  const warnings: string[] = [];
  let best:
    | {
        key: string;
        mece: { isComplete: boolean; canAggregate: boolean; missingValues: string[]; policy: string };
        pvs: ParameterValue[];
      }
    | undefined;

  for (const [key, entry] of byKey.entries()) {
    const mockWindows = Array.from(entry.values).map((v) => ({ sliceDSL: `context(${key}:${v})` }));
    const raw = contextRegistry.detectMECEPartitionSync(mockWindows, key);

    // If the context definition is not available in memory (policy === 'unknown'),
    // degrade gracefully by assuming the user's pinned slice set is intended to be MECE.
    const meceCheck =
      raw.policy === 'unknown'
        ? { isMECE: true, isComplete: true, canAggregate: true, missingValues: [] as string[], policy: 'unknown' }
        : raw;

    if (!meceCheck.isMECE) continue;
    if (!meceCheck.canAggregate) continue;

    // Prefer complete MECE partitions; otherwise keep the best incomplete as a fallback.
    if (!best) {
      best = { key, mece: meceCheck, pvs: entry.pvs };
      continue;
    }
    if (meceCheck.isComplete && !best.mece.isComplete) {
      best = { key, mece: meceCheck, pvs: entry.pvs };
      continue;
    }
    if (meceCheck.isComplete === best.mece.isComplete) {
      // Tie-breaker: choose the key with more slice values present.
      const bestCount = new Set(best.pvs.map((pv) => extractSliceDimensions(pv.sliceDSL ?? ''))).size;
      const thisCount = new Set(entry.pvs.map((pv) => extractSliceDimensions(pv.sliceDSL ?? ''))).size;
      if (thisCount > bestCount) best = { key, mece: meceCheck, pvs: entry.pvs };
    }
  }

  if (!best) return null;

  if (keysPresent.length > 1) {
    warnings.push(`Multiple context keys present (${keysPresent.join(', ')}); using MECE key '${best.key}' for implicit uncontexted aggregation`);
  }
  if (best.mece.policy === 'unknown') {
    warnings.push(`Context '${best.key}' definition not loaded; assuming MECE for implicit uncontexted aggregation`);
  }
  if (!best.mece.isComplete && best.mece.missingValues.length > 0) {
    warnings.push(`Incomplete MECE partition for '${best.key}': missing ${best.mece.missingValues.join(', ')}`);
  }

  return {
    best,
    warnings,
    keysPresent,
    ineligibleDims: Array.from(ineligibleDims),
  };
}

/**
 * Return the best available MECE partition candidate for implicit-uncontexted aggregation,
 * without considering (or short-circuiting on) the presence of an explicit uncontexted slice.
 *
 * This supports "recency wins" selection, where an explicit uncontexted slice may still win if newer.
 */
export function findBestMECEPartitionCandidateSync(
  candidateValues: ParameterValue[],
  options?: { requireComplete?: boolean }
): MECEPartitionCandidate | null {
  const requireComplete = options?.requireComplete !== false;
  const computed = computeBestMECEPartitionCandidate(candidateValues);
  if (!computed) return null;
  const { best, warnings } = computed;
  const isComplete = best.mece.isComplete;
  const canAggregate = best.mece.canAggregate;
  if (!canAggregate) return null;
  if (requireComplete && !isComplete) return null;
  return {
    key: best.key,
    isComplete,
    canAggregate,
    missingValues: best.mece.missingValues,
    values: best.pvs,
    warnings,
    policy: best.mece.policy,
  };
}

/**
 * Resolve a MECE partition for implicit-uncontexted aggregation.
 *
 * @param candidateValues Values already narrowed to the correct mode family (window vs cohort).
 * @returns Resolution describing whether to use explicit uncontexted, a MECE partition, or neither.
 */
export function resolveMECEPartitionForImplicitUncontextedSync(
  candidateValues: ParameterValue[],
  options?: MECEResolutionOptions
): MECEResolution {
  const preferMECEWhenAvailable = options?.preferMECEWhenAvailable === true;
  const requireComplete = options?.requireComplete !== false;
  const hasExplicitUncontexted = hasUncontextedSlice(candidateValues);

  const computed = computeBestMECEPartitionCandidate(candidateValues);
  if (!computed) {
    if (hasExplicitUncontexted) return { kind: 'explicit_uncontexted_present' };
    return {
      kind: 'not_resolvable',
      reason: 'No eligible single-key context slices found to form a MECE partition',
      warnings: [],
    };
  }
  const { best, warnings, keysPresent, ineligibleDims } = computed;

  const result: MECEResolution = {
    kind: 'mece_partition',
    key: best.key,
    isComplete: best.mece.isComplete,
    canAggregate: best.mece.canAggregate,
    missingValues: best.mece.missingValues,
    values: best.pvs,
    warnings,
  };

  const isUsableCompletePartition = result.kind === 'mece_partition' && result.canAggregate && (!requireComplete || result.isComplete);

  // Preference rule: if an explicit uncontexted slice exists AND a complete MECE partition exists,
  // use MECE to avoid mixing datasets across scenarios.
  if (preferMECEWhenAvailable && hasExplicitUncontexted && isUsableCompletePartition) {
    return result;
  }

  // Default rule: if an explicit uncontexted slice exists, use it.
  if (hasExplicitUncontexted) {
    return { kind: 'explicit_uncontexted_present' };
  }

  // Otherwise return the best MECE partition (even if incomplete, unless requireComplete=true and it's incomplete).
  if (requireComplete && result.kind === 'mece_partition' && !result.isComplete) {
    return {
      kind: 'not_resolvable',
      reason: `Incomplete MECE partition for '${result.key}'`,
      warnings: result.warnings,
    };
  }

  return result;
}

export async function resolveMECEPartitionForImplicitUncontexted(
  candidateValues: ParameterValue[],
  options?: MECEResolutionOptions
): Promise<MECEResolution> {
  return resolveMECEPartitionForImplicitUncontextedSync(candidateValues, options);
}


