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
  if (keysPresent.length === 0) {
    return {
      kind: 'not_resolvable',
      reason: 'No eligible single-key context slices found to form a MECE partition',
      warnings: ineligibleDims.size > 0 ? [`Ineligible slice dimensions present: ${Array.from(ineligibleDims).join(', ')}`] : [],
    };
  }

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
    // This preserves resumability and avoids requiring the user to open context files
    // before uncontexted queries can work.
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

  if (!best) {
    // If we have an explicit uncontexted slice and we're not preferring MECE (or none found),
    // prefer the explicit uncontexted data.
    if (hasExplicitUncontexted) return { kind: 'explicit_uncontexted_present' };
    return {
      kind: 'not_resolvable',
      reason: `No MECE-eligible context key found among: ${keysPresent.join(', ')}`,
      warnings: ['Ensure the context definition declares MECE via otherPolicy (null/computed/explicit)'],
    };
  }

  if (keysPresent.length > 1) {
    warnings.push(`Multiple context keys present (${keysPresent.join(', ')}); using MECE key '${best.key}' for implicit uncontexted aggregation`);
  }
  if (best.mece.policy === 'unknown') {
    warnings.push(`Context '${best.key}' definition not loaded; assuming MECE for implicit uncontexted aggregation`);
  }
  if (!best.mece.isComplete && best.mece.missingValues.length > 0) {
    warnings.push(`Incomplete MECE partition for '${best.key}': missing ${best.mece.missingValues.join(', ')}`);
  }

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


