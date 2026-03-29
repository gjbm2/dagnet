/**
 * Posterior slice resolution — doc 25 §2.
 *
 * Given an effective query DSL and a set of posterior slices (from the
 * parameter file), select the best-matching SlicePosteriorEntry.
 *
 * Uses the same normalisation primitives as the fetch planner
 * (extractSliceDimensions, canonicaliseSliceKeyForMatching) so that
 * slice keys match deterministically.
 *
 * Pure functions, no side effects.
 */

import type { SlicePosteriorEntry, Posterior } from '../types';
import { extractSliceDimensions } from './sliceIsolation';
import { canonicaliseSliceKeyForMatching } from '../lib/sliceKeyNormalisation';

// ── Temporal mode detection ─────────────────────────────────────────────────

/**
 * Detect whether a DSL string implies window or cohort mode.
 * Returns 'window' by default (the common case).
 */
export function detectTemporalMode(dsl: string): 'window' | 'cohort' {
  if (!dsl) return 'window';
  return /\bcohort\s*\(/.test(dsl) ? 'cohort' : 'window';
}

// ── Slice key construction ──────────────────────────────────────────────────

/**
 * Build the ideal posterior slice key from an effective DSL.
 *
 * Extracts context/case dimensions (via extractSliceDimensions) and appends
 * the temporal mode. Result is canonicalised for matching.
 *
 * Examples:
 *   'from(a).to(b).context(channel:google).window(1-Nov:30-Nov)'
 *     → 'context(channel:google).window()'
 *   'from(a).to(b).cohort(1-Jan:27-Mar)'
 *     → 'cohort()'
 *   '' or undefined
 *     → 'window()'
 */
export function buildSliceKey(effectiveDsl: string): string {
  const dims = extractSliceDimensions(effectiveDsl || '');
  const mode = detectTemporalMode(effectiveDsl || '');
  const raw = dims ? `${dims}.${mode}()` : `${mode}()`;
  return canonicaliseSliceKeyForMatching(raw);
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve the best-matching SlicePosteriorEntry from a posterior's slices
 * dict, given the effective query DSL.
 *
 * Resolution order (doc 25 §2.1):
 *   1. Exact match — canonicalised ideal key against available keys
 *   2. Fallback — strip context, try aggregate (bare mode: 'window()' or 'cohort()')
 *   3. undefined — no match
 *
 * @param slices  The `posterior.slices` dict from the parameter file
 * @param effectiveDsl  The effective query DSL (with temporal + context qualifiers)
 * @returns The matching entry, or undefined
 */
export function resolvePosteriorSlice(
  slices: Record<string, SlicePosteriorEntry> | undefined,
  effectiveDsl: string,
): SlicePosteriorEntry | undefined {
  if (!slices || Object.keys(slices).length === 0) return undefined;

  const idealKey = buildSliceKey(effectiveDsl);

  // Build a normalised lookup map from the available slice keys
  const normalisedMap = new Map<string, SlicePosteriorEntry>();
  for (const [rawKey, entry] of Object.entries(slices)) {
    const norm = canonicaliseSliceKeyForMatching(rawKey);
    normalisedMap.set(norm, entry);
  }

  // 1. Exact match
  const exact = normalisedMap.get(idealKey);
  if (exact) return exact;

  // 2. Fallback: strip context → aggregate mode
  const mode = detectTemporalMode(effectiveDsl);
  const aggregateKey = `${mode}()`;
  const aggregate = normalisedMap.get(aggregateKey);
  if (aggregate) return aggregate;

  // 3. No match
  return undefined;
}

// ── Projection helpers ──────────────────────────────────────────────────────

/**
 * Project a ProbabilityPosterior shape from posterior slices, given the
 * effective query DSL. Used by the cascade and analysis graph composition.
 *
 * Returns the shape that goes onto `p.posterior` on the graph edge, or
 * undefined if no suitable slice exists.
 */
export function projectProbabilityPosterior(
  posterior: Posterior | undefined,
  effectiveDsl: string,
): Record<string, any> | undefined {
  if (!posterior?.slices) return undefined;

  const primary = resolvePosteriorSlice(posterior.slices, effectiveDsl);
  if (!primary) return undefined;

  // Also try the "other" mode for path-level fields
  const primaryMode = detectTemporalMode(effectiveDsl);
  const otherMode = primaryMode === 'window' ? 'cohort' : 'window';
  const dims = extractSliceDimensions(effectiveDsl || '');
  const otherKey = dims ? `${dims}.${otherMode}()` : `${otherMode}()`;
  const otherNorm = canonicaliseSliceKeyForMatching(otherKey);

  // Find the other-mode slice for path-level fields
  let otherSlice: SlicePosteriorEntry | undefined;
  for (const [rawKey, entry] of Object.entries(posterior.slices)) {
    if (canonicaliseSliceKeyForMatching(rawKey) === otherNorm) {
      otherSlice = entry;
      break;
    }
  }

  return {
    distribution: 'beta',
    alpha: primary.alpha,
    beta: primary.beta,
    hdi_lower: primary.p_hdi_lower,
    hdi_upper: primary.p_hdi_upper,
    hdi_level: posterior.hdi_level ?? 0.9,
    ess: primary.ess,
    rhat: primary.rhat,
    evidence_grade: primary.evidence_grade ?? 0,
    fitted_at: posterior.fitted_at,
    fingerprint: posterior.fingerprint,
    provenance: primary.provenance ?? 'bayesian',
    divergences: primary.divergences ?? 0,
    prior_tier: posterior.prior_tier ?? 'uninformative',
    surprise_z: posterior.surprise_z,
    // Path-level from the other mode's slice
    ...(otherSlice?.alpha != null ? {
      path_alpha: otherSlice.alpha,
      path_beta: otherSlice.beta,
      path_hdi_lower: otherSlice.p_hdi_lower,
      path_hdi_upper: otherSlice.p_hdi_upper,
      path_provenance: otherSlice.provenance ?? 'bayesian',
    } : {}),
  };
}

/**
 * Project a LatencyPosterior shape from posterior slices, given the
 * effective query DSL. Used by the cascade and analysis graph composition.
 *
 * Returns the shape that goes onto `p.latency.posterior` on the graph edge,
 * or undefined if no suitable slice has latency data.
 */
export function projectLatencyPosterior(
  posterior: Posterior | undefined,
  effectiveDsl: string,
): Record<string, any> | undefined {
  if (!posterior?.slices) return undefined;

  const primary = resolvePosteriorSlice(posterior.slices, effectiveDsl);
  if (!primary?.mu_mean) return undefined;

  const primaryMode = detectTemporalMode(effectiveDsl);
  const otherMode = primaryMode === 'window' ? 'cohort' : 'window';
  const dims = extractSliceDimensions(effectiveDsl || '');
  const otherKey = dims ? `${dims}.${otherMode}()` : `${otherMode}()`;
  const otherNorm = canonicaliseSliceKeyForMatching(otherKey);

  let otherSlice: SlicePosteriorEntry | undefined;
  for (const [rawKey, entry] of Object.entries(posterior.slices)) {
    if (canonicaliseSliceKeyForMatching(rawKey) === otherNorm) {
      otherSlice = entry;
      break;
    }
  }

  return {
    distribution: 'lognormal',
    onset_delta_days: primary.onset_mean ?? 0,
    mu_mean: primary.mu_mean,
    mu_sd: primary.mu_sd,
    sigma_mean: primary.sigma_mean,
    sigma_sd: primary.sigma_sd,
    hdi_t95_lower: primary.hdi_t95_lower,
    hdi_t95_upper: primary.hdi_t95_upper,
    hdi_level: posterior.hdi_level ?? 0.9,
    ess: primary.ess,
    rhat: primary.rhat,
    fitted_at: posterior.fitted_at,
    fingerprint: posterior.fingerprint,
    provenance: primary.provenance ?? 'bayesian',
    ...(primary.onset_mean != null ? { onset_mean: primary.onset_mean, onset_sd: primary.onset_sd } : {}),
    ...(primary.onset_mu_corr != null ? { onset_mu_corr: primary.onset_mu_corr } : {}),
    // Path-level from the other mode's slice
    ...(otherSlice?.mu_mean != null ? {
      path_onset_delta_days: otherSlice.onset_mean,
      path_onset_sd: otherSlice.onset_sd,
      path_mu_mean: otherSlice.mu_mean,
      path_mu_sd: otherSlice.mu_sd,
      path_sigma_mean: otherSlice.sigma_mean,
      path_sigma_sd: otherSlice.sigma_sd,
      ...(otherSlice.hdi_t95_lower != null ? { path_hdi_t95_lower: otherSlice.hdi_t95_lower, path_hdi_t95_upper: otherSlice.hdi_t95_upper } : {}),
      ...(otherSlice.onset_mu_corr != null ? { path_onset_mu_corr: otherSlice.onset_mu_corr } : {}),
      path_provenance: otherSlice.provenance,
    } : {}),
  };
}
