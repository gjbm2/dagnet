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

import type { SlicePosteriorEntry, Posterior, FitHistoryEntry } from '../types';
import { extractSliceDimensions } from './sliceIsolation';
import { canonicaliseSliceKeyForMatching } from '../lib/sliceKeyNormalisation';
import { parseUKDate } from '../lib/dateFormat';

/**
 * Normalise an old-shape slice entry (doc 49 naming) to the new shape (doc 61).
 *
 * Old shape: bare `mu_sd` was predictive-when-kappa-fitted else epistemic-fallback;
 *            `mu_sd_epist` was always epistemic.
 * New shape: bare `mu_sd` is always epistemic;
 *            `mu_sd_pred` is always predictive (kappa_lat-inflated) or absent.
 *
 * Detection: presence of `mu_sd_epist` with no `mu_sd_pred` identifies an
 * old-shape entry produced by a pre-rename Bayes compiler or stored in an
 * unmigrated parameter file. Pure function, idempotent: new-shape inputs
 * pass through unchanged. See doc 61.
 */
export function normaliseSliceShape(slice: any): any {
  if (!slice || typeof slice !== 'object') return slice;
  const hasEpist = slice.mu_sd_epist != null || slice.path_mu_sd_epist != null;
  const hasPred = slice.mu_sd_pred != null || slice.path_mu_sd_pred != null;
  if (!hasEpist || hasPred) return slice;

  const out: any = { ...slice };
  if (slice.mu_sd_epist != null) {
    // Old mu_sd (predictive-or-epistemic) → new mu_sd_pred
    if (slice.mu_sd != null) out.mu_sd_pred = slice.mu_sd;
    // Old mu_sd_epist (always epistemic) → new bare mu_sd
    out.mu_sd = slice.mu_sd_epist;
    delete out.mu_sd_epist;
  }
  if (slice.path_mu_sd_epist != null) {
    if (slice.path_mu_sd != null) out.path_mu_sd_pred = slice.path_mu_sd;
    out.path_mu_sd = slice.path_mu_sd_epist;
    delete out.path_mu_sd_epist;
  }
  return out;
}

/**
 * Normalise every slice in a posterior.slices dict in-place-returning-new.
 * Caller responsibility: do not mutate the input; the FE store expects
 * immutable updates via setGraph to trigger React re-renders.
 */
export function normalisePosteriorSlices(posterior: any): any {
  if (!posterior || typeof posterior !== 'object') return posterior;
  const slices = posterior.slices;
  if (!slices || typeof slices !== 'object') return posterior;
  const out: Record<string, any> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(slices)) {
    const normalised = normaliseSliceShape(entry);
    out[key] = normalised;
    if (normalised !== entry) changed = true;
  }
  if (!changed) return posterior;
  return { ...posterior, slices: out };
}

/**
 * Parse a date string that may be UK format (d-MMM-yy) or ISO
 * (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ). Returns UTC midnight for the
 * calendar day so that date-only comparisons work correctly (a fit
 * produced at 18:49 on 31-Mar is still "on" 31-Mar).
 */
function parseDateToMidnightMs(dateStr: string): number {
  // Try UK format first (d-MMM-yy)
  try {
    return parseUKDate(dateStr).getTime();
  } catch { /* not UK format */ }

  // ISO datetime or date: extract YYYY-MM-DD and build UTC midnight
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (isoMatch) {
    return Date.UTC(
      parseInt(isoMatch[1], 10),
      parseInt(isoMatch[2], 10) - 1,
      parseInt(isoMatch[3], 10),
    );
  }

  throw new Error(`Unparseable date: ${dateStr}`);
}

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
 * Resolution order:
 *   1. Exact match — canonicalised ideal key against available keys
 *   2. Bare-mode aggregate — only when the DSL specifies no context
 *      (e.g. `window()` / `cohort()` queries with no `context(...)` clauses).
 *      Returning the aggregate IS the literal answer to such queries.
 *   3. undefined — no match
 *
 * Cross-context fallback (DSL specifies `context(c)` but no
 * `context(c).mode()` slice exists) is intentionally NOT performed: the
 * marginal aggregate is a different population from the asked-for
 * conditional, and silent substitution presents the wrong posterior as
 * authoritative. See TODO.md "context-fallback toggle" for the user-
 * facing toggle / provenance / signposting that would make this
 * acceptable as opt-in behaviour.
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

  // 2. Bare-mode aggregate ONLY when no context was specified.
  //    When `idealKey === aggregateKey` the DSL had no `context(...)`
  //    clauses, so the aggregate IS what the user asked for.
  const mode = detectTemporalMode(effectiveDsl);
  const aggregateKey = `${mode}()`;
  if (idealKey === aggregateKey) {
    const aggregate = normalisedMap.get(aggregateKey);
    if (aggregate) return aggregate;
  }

  // 3. No match (context specified but no matching slice — strict).
  return undefined;
}

// ── Projection helpers ──────────────────────────────────────────────────────

/**
 * Project a ProbabilityPosterior shape from posterior slices, given the
 * effective query DSL. Used by the cascade and analysis graph composition.
 *
 * Edge-level fields ALWAYS come from window() and path-level fields ALWAYS
 * come from cohort(), regardless of which mode the DSL selects. The DSL
 * controls which slice is "active" for analysis routing, but the edge/path
 * semantic split is fixed: window = edge, cohort = path.
 *
 * Returns the shape that goes onto `p.posterior` on the graph edge, or
 * undefined if no suitable slice exists.
 */
export function projectProbabilityPosterior(
  posterior: Posterior | undefined,
  effectiveDsl: string,
): Record<string, any> | undefined {
  if (!posterior?.slices) return undefined;

  // Edge-level: always from window(). Path-level: always from cohort().
  // Context dimensions from the DSL are preserved for both lookups.
  const dims = extractSliceDimensions(effectiveDsl || '');
  const windowSlice = _findSliceByMode(posterior.slices, 'window', dims);
  const cohortSlice = _findSliceByMode(posterior.slices, 'cohort', dims);

  // Need at least the window slice for edge-level fields
  const edgeSlice = windowSlice;
  if (!edgeSlice) return undefined;

  // The "active" slice determines analysis-level metadata (ESS, rhat)
  const activeMode = detectTemporalMode(effectiveDsl);
  const activeSlice = activeMode === 'cohort' ? (cohortSlice ?? edgeSlice) : edgeSlice;

  return {
    distribution: 'beta',
    // Epistemic (doc 49)
    alpha: edgeSlice.alpha,
    beta: edgeSlice.beta,
    hdi_lower: edgeSlice.p_hdi_lower,
    hdi_upper: edgeSlice.p_hdi_upper,
    hdi_level: posterior.hdi_level ?? 0.9,
    // Predictive (doc 49) — absent when kappa absent
    ...(edgeSlice.alpha_pred != null ? {
      alpha_pred: edgeSlice.alpha_pred,
      beta_pred: edgeSlice.beta_pred,
      hdi_lower_pred: edgeSlice.hdi_lower_pred,
      hdi_upper_pred: edgeSlice.hdi_upper_pred,
    } : {}),
    // Quality / provenance
    ess: activeSlice.ess,
    rhat: activeSlice.rhat,
    evidence_grade: activeSlice.evidence_grade ?? 0,
    fitted_at: posterior.fitted_at,
    fingerprint: posterior.fingerprint,
    provenance: edgeSlice.provenance ?? 'bayesian',
    divergences: activeSlice.divergences ?? 0,
    prior_tier: posterior.prior_tier ?? 'uninformative',
    surprise_z: posterior.surprise_z,
    // Cohort-mode epistemic from cohort() slice
    ...(cohortSlice?.alpha != null ? {
      cohort_alpha: cohortSlice.alpha,
      cohort_beta: cohortSlice.beta,
      cohort_hdi_lower: cohortSlice.p_hdi_lower,
      cohort_hdi_upper: cohortSlice.p_hdi_upper,
      cohort_provenance: cohortSlice.provenance ?? 'bayesian',
    } : {}),
    // Cohort-mode predictive (doc 49)
    ...(cohortSlice?.alpha_pred != null ? {
      cohort_alpha_pred: cohortSlice.alpha_pred,
      cohort_beta_pred: cohortSlice.beta_pred,
      cohort_hdi_lower_pred: cohortSlice.hdi_lower_pred,
      cohort_hdi_upper_pred: cohortSlice.hdi_upper_pred,
    } : {}),
  };
}

/**
 * Project a LatencyPosterior shape from posterior slices, given the
 * effective query DSL. Used by the cascade and analysis graph composition.
 *
 * Edge-level latency ALWAYS comes from window() and path-level latency
 * ALWAYS comes from cohort(), regardless of DSL mode. See
 * projectProbabilityPosterior for rationale.
 *
 * Returns the shape that goes onto `p.latency.posterior` on the graph edge,
 * or undefined if no suitable slice has latency data.
 */
export function projectLatencyPosterior(
  posterior: Posterior | undefined,
  effectiveDsl: string,
): Record<string, any> | undefined {
  if (!posterior?.slices) return undefined;

  const dims = extractSliceDimensions(effectiveDsl || '');
  // Normalise old-shape slice entries (doc 61 migration shim) so downstream
  // projection logic can assume the new naming: bare = epistemic, _pred = predictive.
  const rawWindow = _findSliceByMode(posterior.slices, 'window', dims);
  const rawCohort = _findSliceByMode(posterior.slices, 'cohort', dims);
  const windowSlice = rawWindow ? (normaliseSliceShape(rawWindow) as SlicePosteriorEntry) : undefined;
  const cohortSlice = rawCohort ? (normaliseSliceShape(rawCohort) as SlicePosteriorEntry) : undefined;

  // Edge-level latency from window() slice
  const edgeSlice = windowSlice;
  if (!edgeSlice?.mu_mean) return undefined;

  const activeMode = detectTemporalMode(effectiveDsl);
  const activeSlice = activeMode === 'cohort' ? (cohortSlice ?? edgeSlice) : edgeSlice;

  return {
    distribution: 'lognormal',
    onset_delta_days: edgeSlice.onset_mean ?? 0,
    mu_mean: edgeSlice.mu_mean,
    mu_sd: edgeSlice.mu_sd,                   // epistemic (doc 61)
    ...(edgeSlice.mu_sd_pred != null ? { mu_sd_pred: edgeSlice.mu_sd_pred } : {}),
    sigma_mean: edgeSlice.sigma_mean,
    sigma_sd: edgeSlice.sigma_sd,
    hdi_t95_lower: edgeSlice.hdi_t95_lower,
    hdi_t95_upper: edgeSlice.hdi_t95_upper,
    hdi_level: posterior.hdi_level ?? 0.9,
    ess: activeSlice.ess,
    rhat: activeSlice.rhat,
    fitted_at: posterior.fitted_at,
    fingerprint: posterior.fingerprint,
    provenance: edgeSlice.provenance ?? 'bayesian',
    ...(edgeSlice.onset_mean != null ? { onset_mean: edgeSlice.onset_mean, onset_sd: edgeSlice.onset_sd } : {}),
    ...(edgeSlice.onset_mu_corr != null ? { onset_mu_corr: edgeSlice.onset_mu_corr } : {}),
    // Path-level from cohort() slice
    ...(cohortSlice?.mu_mean != null ? {
      path_onset_delta_days: cohortSlice.onset_mean,
      path_onset_sd: cohortSlice.onset_sd,
      path_mu_mean: cohortSlice.mu_mean,
      path_mu_sd: cohortSlice.mu_sd,
      ...(cohortSlice.mu_sd_pred != null ? { path_mu_sd_pred: cohortSlice.mu_sd_pred } : {}),
      path_sigma_mean: cohortSlice.sigma_mean,
      path_sigma_sd: cohortSlice.sigma_sd,
      ...(cohortSlice.hdi_t95_lower != null ? { path_hdi_t95_lower: cohortSlice.hdi_t95_lower, path_hdi_t95_upper: cohortSlice.hdi_t95_upper } : {}),
      ...(cohortSlice.onset_mu_corr != null ? { path_onset_mu_corr: cohortSlice.onset_mu_corr } : {}),
      path_provenance: cohortSlice.provenance,
    } : {}),
  };
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Find a slice by explicit temporal mode, optionally scoped to context dims.
 *
 * When `dims` is set (DSL specified one or more `context(...)` clauses),
 * matches the context-qualified key strictly — no silent fallback to the
 * bare aggregate. The marginal aggregate is a different population from
 * the asked-for conditional. See `resolvePosteriorSlice` and TODO.md
 * "context-fallback toggle".
 *
 * When `dims` is empty (DSL had no context), returns the bare-mode
 * aggregate slice — that IS what the caller asked for.
 */
function _findSliceByMode(
  slices: Record<string, SlicePosteriorEntry>,
  mode: 'window' | 'cohort',
  dims: string,
): SlicePosteriorEntry | undefined {
  if (dims) {
    const qualifiedKey = canonicaliseSliceKeyForMatching(`${dims}.${mode}()`);
    for (const [rawKey, entry] of Object.entries(slices)) {
      if (canonicaliseSliceKeyForMatching(rawKey) === qualifiedKey) return entry;
    }
    // Context specified but no matching slice — strict, no cross-context fallback.
    return undefined;
  }
  // No context specified: bare aggregate is the literal answer.
  const bareKey = `${mode}()`;
  for (const [rawKey, entry] of Object.entries(slices)) {
    if (canonicaliseSliceKeyForMatching(rawKey) === bareKey) return entry;
  }
  return undefined;
}

// ── asat posterior resolution (doc 27 §5) ─────────────────────────────────

/**
 * Resolve the historical posterior for an asat query.
 *
 * Semantics: "what would the user have seen if they ran this query on
 * `asatDate`?" Returns the most recent fit whose `fitted_at <= asatDate`.
 *
 * Selection order:
 *   1. If the current posterior's `fitted_at <= asatDate`, return it directly.
 *   2. Otherwise search `fit_history` for the most recent entry on or before.
 *   3. If no entry matches, return undefined — strict, no fallback.
 *
 * When a fit_history entry is selected, a synthetic `Posterior`-shaped object
 * is constructed so callers can pass it to the existing projection functions
 * without adaptation.
 *
 * @param posterior  The full Posterior from the parameter file
 * @param asatDate   UK date string (d-MMM-yy) from the parsed query constraints
 * @returns A Posterior-shaped object for the historical fit, or undefined
 */
export function resolveAsatPosterior(
  posterior: Posterior | undefined,
  asatDate: string,
): Posterior | undefined {
  if (!posterior) return undefined;

  let asatMs: number;
  try {
    asatMs = parseDateToMidnightMs(asatDate);
  } catch {
    return undefined;
  }

  // 1. Check current posterior first
  try {
    const currentMs = parseDateToMidnightMs(posterior.fitted_at);
    if (currentMs <= asatMs) return posterior;
  } catch { /* parse failure on current — fall through to history */ }

  // 2. Search fit_history for most recent on-or-before
  const history = posterior.fit_history;
  if (!history || history.length === 0) return undefined;

  let best: FitHistoryEntry | undefined;
  let bestMs = -Infinity;

  for (const entry of history) {
    try {
      const entryMs = parseDateToMidnightMs(entry.fitted_at);
      if (entryMs <= asatMs && entryMs > bestMs) {
        best = entry;
        bestMs = entryMs;
      }
    } catch { /* skip unparseable entries */ }
  }

  if (!best) return undefined;

  // 3. Construct synthetic Posterior from the history entry
  return {
    fitted_at: best.fitted_at,
    fingerprint: best.fingerprint,
    hdi_level: best.hdi_level ?? posterior.hdi_level ?? 0.9,
    prior_tier: (best.prior_tier ?? posterior.prior_tier ?? 'uninformative') as Posterior['prior_tier'],
    slices: best.slices as Record<string, SlicePosteriorEntry>,
  };
}
