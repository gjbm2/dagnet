/**
 * Slice plan validation service (pinned query warnings)
 *
 * Non-blocking warnings when user sets pinned `dataInterestsDSL`:
 * - Do we have explicit uncontexted window/cohort slices?
 * - If not, do we at least have an implicit MECE partition for window/cohort?
 *
 * This is service-layer logic (no UI). UI/hook callers can render warnings however they want.
 */
import { explodeDSL } from '../lib/dslExplosion';
import { extractSliceDimensions } from './sliceIsolation';
import { parseConstraints } from '../lib/queryDSL';
import { contextRegistry } from './contextRegistry';

export interface SlicePlanValidationResult {
  warnings: string[];
  diagnostics: {
    hasExplicitWindowUncontexted: boolean;
    hasExplicitCohortUncontexted: boolean;
    hasImplicitWindowMECE: boolean;
    hasImplicitCohortMECE: boolean;
    windowMECEKey?: string;
    cohortMECEKey?: string;
  };
}

function isWindowSlice(dsl: string): boolean {
  return dsl.includes('window(') && !dsl.includes('cohort(');
}

function isCohortSlice(dsl: string): boolean {
  return dsl.includes('cohort(');
}

function isUncontextedSlice(dsl: string): boolean {
  return extractSliceDimensions(dsl) === '';
}

async function findAnyCompleteMECEKeyForMode(
  slices: string[]
): Promise<{ ok: boolean; key?: string }> {
  // Build key -> set(values) from fully exploded slice strings.
  const byKey = new Map<string, Set<string>>();

  for (const s of slices) {
    const dims = extractSliceDimensions(s);
    if (!dims) continue;
    const parsed = parseConstraints(dims);
    if (parsed.contextAny.length > 0) continue;
    if (parsed.context.length !== 1) continue;
    const { key, value } = parsed.context[0];
    if (!key || !value) continue;
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key)!.add(value);
  }

  for (const [key, values] of byKey.entries()) {
    const mock = Array.from(values).map(v => ({ sliceDSL: `context(${key}:${v})` }));
    const check = await contextRegistry.detectMECEPartition(mock, key);
    if (check.isMECE && check.canAggregate && check.isComplete) {
      return { ok: true, key };
    }
  }

  return { ok: false };
}

export async function validatePinnedDataInterestsDSL(dsl: string): Promise<SlicePlanValidationResult> {
  const warnings: string[] = [];

  if (!dsl || !dsl.trim()) {
    return {
      warnings: ['Pinned data interests DSL is empty; nightly slice fetching will not run.'],
      diagnostics: {
        hasExplicitWindowUncontexted: false,
        hasExplicitCohortUncontexted: false,
        hasImplicitWindowMECE: false,
        hasImplicitCohortMECE: false,
      },
    };
  }

  let slices: string[] = [];
  try {
    slices = await explodeDSL(dsl);
  } catch (e) {
    return {
      warnings: [`Pinned data interests DSL could not be expanded; please check syntax. (${e instanceof Error ? e.message : String(e)})`],
      diagnostics: {
        hasExplicitWindowUncontexted: false,
        hasExplicitCohortUncontexted: false,
        hasImplicitWindowMECE: false,
        hasImplicitCohortMECE: false,
      },
    };
  }

  const windowSlices = slices.filter(isWindowSlice);
  const cohortSlices = slices.filter(isCohortSlice);

  const hasExplicitWindowUncontexted = windowSlices.some(isUncontextedSlice);
  const hasExplicitCohortUncontexted = cohortSlices.some(isUncontextedSlice);

  // Cohort-mode queries derive forecasts/baselines from window-mode slices of the same slice family.
  // If the pinned plan includes cohort slices but no window slices at all, warn explicitly (advisory only).
  const dslMentionsCohort = dsl.includes('cohort(');
  const dslMentionsWindow = dsl.includes('window(');
  if ((cohortSlices.length > 0 || dslMentionsCohort) && windowSlices.length === 0 && !dslMentionsWindow) {
    warnings.push(
      'Pinned data interests include cohort() slices but no window() slices. Cohort-mode forecasts/baselines are derived from window() data, so some cohort() results may be unavailable or behave unexpectedly until a matching window() slice is fetched.'
    );
  }

  const windowMECE = hasExplicitWindowUncontexted ? { ok: false as const } : await findAnyCompleteMECEKeyForMode(windowSlices);
  const cohortMECE = hasExplicitCohortUncontexted ? { ok: false as const } : await findAnyCompleteMECEKeyForMode(cohortSlices);

  const hasImplicitWindowMECE = windowMECE.ok;
  const hasImplicitCohortMECE = cohortMECE.ok;

  if (!hasExplicitWindowUncontexted && !hasImplicitWindowMECE) {
    warnings.push('Pinned slices do not provide an explicit or implicit uncontexted WINDOW baseline; some uncontexted window() queries may require additional slices.');
  }
  if (!hasExplicitCohortUncontexted && !hasImplicitCohortMECE) {
    warnings.push('Pinned slices do not provide an explicit or implicit uncontexted COHORT set; some uncontexted cohort() queries may require additional slices.');
  }

  if (hasImplicitWindowMECE && hasImplicitCohortMECE && windowMECE.key && cohortMECE.key && windowMECE.key !== cohortMECE.key) {
    warnings.push(`Pinned slices imply MECE via different keys for window vs cohort (window=${windowMECE.key}, cohort=${cohortMECE.key}). Uncontexted cohort queries may not behave as expected.`);
  }

  return {
    warnings,
    diagnostics: {
      hasExplicitWindowUncontexted,
      hasExplicitCohortUncontexted,
      hasImplicitWindowMECE,
      hasImplicitCohortMECE,
      windowMECEKey: windowMECE.ok ? windowMECE.key : undefined,
      cohortMECEKey: cohortMECE.ok ? cohortMECE.key : undefined,
    },
  };
}


