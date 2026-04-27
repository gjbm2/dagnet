/**
 * bayesEngorge — inject observations and priors from parameter files
 * onto graph edges so the BE can read structured data directly.
 *
 * Implements the engorged graph contract (doc 14 §9A). The FE
 * pre-resolves priors and extracts observations from param files,
 * writing them as `_bayes_evidence` and `_bayes_priors` on each edge.
 *
 * This module is used by both the browser hook (useBayesTrigger) and
 * the Node CLI — no browser APIs allowed.
 */

import { cloneGraphWithoutBayesRuntimeFields } from './bayesGraphRuntime';

// ---------------------------------------------------------------------------
// Constants — must match the Python BE (compiler/types.py, evidence.py)
// ---------------------------------------------------------------------------

/** Max effective sample size for warm-start prior (ESS_CAP in types.py). */
const ESS_CAP = 500;

/** Quality gate: max rhat for warm-start acceptance. */
const WARM_START_RHAT_MAX = 1.10;

/** Quality gate: min ESS for warm-start acceptance. */
const WARM_START_ESS_MIN = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BayesWindowObs {
  n: number;
  k: number;
  sliceDSL: string;
}

export interface BayesCohortObs {
  sliceDSL: string;
  n_daily?: number[];
  k_daily?: number[];
  dates?: string[];
  n?: number;
  k?: number;
}

export interface BayesEvidence {
  window: BayesWindowObs[];
  cohort: BayesCohortObs[];
}

export interface BayesPriors {
  prob_alpha: number;
  prob_beta: number;
  prob_source: string;  // 'warm_start' | 'moment_matched' | 'kn_derived' | 'uninformative'
  latency_onset: number | null;
  latency_mu: number | null;
  latency_sigma: number | null;
  latency_source: string | null;  // 'warm_start' | 'topology'
  onset_uncertainty: number | null;
  kappa: number | null;
  cohort_mu: number | null;
  cohort_sigma: number | null;
  cohort_onset: number | null;
  onset_observations: number[] | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COHORT_RE = /cohort\(/i;
const WINDOW_RE = /window\(/i;

function isCohort(sliceDSL: string): boolean {
  return COHORT_RE.test(sliceDSL);
}

function isWindow(sliceDSL: string): boolean {
  return WINDOW_RE.test(sliceDSL);
}

/**
 * Return true if the posterior slice meets quality gates for warm-start.
 * Mirrors Python `_warm_start_acceptable()` in evidence.py.
 */
function warmStartAcceptable(sliceData: Record<string, any>): boolean {
  const rhat = sliceData.rhat;
  const ess = sliceData.ess;
  if (rhat != null && Number(rhat) > WARM_START_RHAT_MAX) return false;
  if (ess != null && Number(ess) < WARM_START_ESS_MIN) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Evidence extraction
// ---------------------------------------------------------------------------

/**
 * Build `_bayes_evidence` from parameter file `values[]`.
 *
 * Classifies each values entry as window or cohort by inspecting
 * its sliceDSL string, following the same regex logic as the Python
 * BE (evidence.py `_is_cohort()` / `_is_window()`).
 */
function buildEvidence(pf: Record<string, any>): BayesEvidence {
  const evidence: BayesEvidence = { window: [], cohort: [] };
  const values: any[] = Array.isArray(pf.values) ? pf.values : [];

  for (const entry of values) {
    if (!entry || typeof entry !== 'object') continue;
    const dsl: string = entry.sliceDSL ?? '';

    if (isCohort(dsl)) {
      const obs: BayesCohortObs = { sliceDSL: dsl };
      if (Array.isArray(entry.n_daily)) obs.n_daily = entry.n_daily;
      if (Array.isArray(entry.k_daily)) obs.k_daily = entry.k_daily;
      if (Array.isArray(entry.dates)) obs.dates = entry.dates;
      if (entry.n != null) obs.n = Number(entry.n);
      if (entry.k != null) obs.k = Number(entry.k);
      evidence.cohort.push(obs);
    } else if (isWindow(dsl) || (entry.n != null && entry.k != null)) {
      // Window: entries with "window(" in DSL, OR entries with no temporal
      // qualifier but with n/k (treated as aggregate window observations).
      evidence.window.push({
        n: Number(entry.n ?? 0),
        k: Number(entry.k ?? 0),
        sliceDSL: dsl,
      });
    }
    // Entries with neither qualifier nor n/k are skipped.
  }

  return evidence;
}

// ---------------------------------------------------------------------------
// Prior resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the probability prior for an edge.
 *
 * Priority chain (mirrors Python `_resolve_prior()` in evidence.py):
 *   1. Warm-start from previous posterior.slices["window()"] (if quality OK)
 *      — SKIPPED if bayes_reset flag is set
 *   2. Legacy warm-start from posterior.alpha/beta
 *   3. Moment-matched from values[0].mean/stdev
 *   4. k-n derivation from values[0].n/k
 *   5. Uninformative Beta(1, 1)
 */
function resolveProbPrior(pf: Record<string, any>): { alpha: number; beta: number; source: string } {
  const bayesReset = !!((pf.latency ?? {}) as Record<string, any>).bayes_reset;
  const posterior: Record<string, any> | null =
    typeof pf.posterior === 'object' && pf.posterior ? pf.posterior : null;

  let alphaRaw: number | null = null;
  let betaRaw: number | null = null;

  if (posterior && !bayesReset) {
    // Unified schema: slices["window()"].alpha/beta
    const slices = posterior.slices;
    if (typeof slices === 'object' && slices) {
      const ws = slices['window()'];
      if (ws && ws.alpha && ws.beta && warmStartAcceptable(ws)) {
        alphaRaw = Number(ws.alpha);
        betaRaw = Number(ws.beta);
      }
    }
    // Legacy fallback: top-level alpha/beta
    if (alphaRaw == null && posterior.alpha && posterior.beta) {
      alphaRaw = Number(posterior.alpha);
      betaRaw = Number(posterior.beta);
    }
  }

  if (alphaRaw != null && betaRaw != null) {
    let alpha = alphaRaw;
    let beta = betaRaw;
    // ESS cap: if prior is too informative, scale down
    const ess = alpha + beta;
    if (ess > ESS_CAP) {
      const scale = ESS_CAP / ess;
      alpha *= scale;
      beta *= scale;
    }
    if (alpha > 0 && beta > 0) {
      return { alpha, beta, source: 'warm_start' };
    }
  }

  // Moment-matched from point estimates
  const values: any[] = Array.isArray(pf.values) ? pf.values : [];
  const values0 = values.length > 0 && typeof values[0] === 'object' ? values[0] : null;

  if (values0) {
    const mean = values0.mean;
    const stdev = values0.stdev;
    if (mean != null && stdev != null) {
      const m = Number(mean);
      const s = Number(stdev);
      if (m > 0 && m < 1 && s > 0) {
        const v = s * s;
        if (v < m * (1 - m)) {
          const common = (m * (1 - m) / v) - 1;
          if (common > 0) {
            let alpha = m * common;
            let beta = (1 - m) * common;
            const ess = alpha + beta;
            if (ess > ESS_CAP) {
              const scale = ESS_CAP / ess;
              alpha *= scale;
              beta *= scale;
            }
            return {
              alpha: Math.max(alpha, 0.5),
              beta: Math.max(beta, 0.5),
              source: 'moment_matched',
            };
          }
        }
      }
    }

    // Fallback: derive from k/n when stdev is missing
    const nVal = values0.n;
    const kVal = values0.k;
    if (nVal != null && kVal != null) {
      const nInt = Math.floor(Number(nVal));
      const kInt = Math.floor(Number(kVal));
      if (nInt > 0 && kInt >= 0 && kInt <= nInt) {
        const pseudoN = Math.min(nInt, ESS_CAP);
        const alpha = Math.max((kInt / nInt) * pseudoN, 0.5);
        const beta = Math.max((1 - kInt / nInt) * pseudoN, 0.5);
        return { alpha, beta, source: 'kn_derived' };
      }
    }
  }

  return { alpha: 1.0, beta: 1.0, source: 'uninformative' };
}

/**
 * Resolve latency prior for an edge.
 *
 * Priority chain (mirrors Python `_resolve_latency_prior()` in evidence.py):
 *   1. Warm-start from posterior.slices["window()"].mu_mean/sigma_mean
 *      — SKIPPED if bayes_reset flag is set
 *   2. Topology-derived from graph edge (mu_prior/sigma_prior from stats pass)
 *
 * Returns null fields when latency is not applicable.
 */
function resolveLatencyPrior(
  edge: Record<string, any>,
  pf: Record<string, any>,
): { onset: number | null; mu: number | null; sigma: number | null; source: string | null; onsetUncertainty: number | null } {
  // Topology-derived defaults from the edge's model_vars or direct fields.
  const mv = edge.model_vars ?? {};
  let onset: number | null = mv.onset ?? edge.onset_delta_days ?? null;
  let mu: number | null = mv.mu ?? edge.mu_prior ?? null;
  let sigma: number | null = mv.sigma ?? edge.sigma_prior ?? null;
  let source: string | null = (onset != null || mu != null) ? 'topology' : null;

  const bayesReset = !!((pf.latency ?? {}) as Record<string, any>).bayes_reset;

  if (!bayesReset) {
    const posterior: Record<string, any> | null =
      typeof pf.posterior === 'object' && pf.posterior ? pf.posterior : null;
    if (posterior) {
      const slices = posterior.slices;
      if (typeof slices === 'object' && slices) {
        const ws = slices['window()'] ?? {};
        const prevMu = ws.mu_mean;
        const prevSigma = ws.sigma_mean;
        if (prevMu != null && prevSigma != null && warmStartAcceptable(ws)) {
          mu = Number(prevMu);
          sigma = Number(prevSigma);
          source = 'warm_start';
        }
      }
    }
  }

  const onsetNum = onset != null ? Number(onset) : null;
  const onsetUncertainty = onsetNum != null ? Math.max(1.0, onsetNum * 0.3) : null;

  return {
    onset: onsetNum,
    mu: mu != null ? Number(mu) : null,
    sigma: sigma != null ? Number(sigma) : null,
    source,
    onsetUncertainty,
  };
}

/**
 * Resolve warm-start extras: kappa and cohort latency.
 *
 * Mirrors Python `_resolve_warm_start_extras()` in evidence.py.
 * All values are quality-gated via the window() slice — if the
 * previous run didn't converge, none of these warm-starts are used.
 */
function resolveWarmStartExtras(
  edge: Record<string, any>,
  pf: Record<string, any>,
): { kappa: number | null; cohortMu: number | null; cohortSigma: number | null; cohortOnset: number | null } {
  const result = { kappa: null as number | null, cohortMu: null as number | null, cohortSigma: null as number | null, cohortOnset: null as number | null };

  const posterior: Record<string, any> | null =
    typeof pf.posterior === 'object' && pf.posterior ? pf.posterior : null;
  if (!posterior) return result;

  const slices = posterior.slices;
  if (typeof slices !== 'object' || !slices) return result;

  // Quality gate: check window() slice convergence
  const ws = slices['window()'] ?? {};
  if (!warmStartAcceptable(ws)) return result;

  // Kappa from _model_state
  const ms: Record<string, any> = posterior._model_state ?? {};
  // The edge UUID in _model_state keys has hyphens replaced with underscores
  const edgeId: string = edge.id ?? edge.uuid ?? '';
  const safeEid = edgeId.replace(/-/g, '_');
  const kappaKey = `kappa_${safeEid}`;
  if (kappaKey in ms) {
    const val = Number(ms[kappaKey]);
    if (val > 0) result.kappa = val;
  }

  // Cohort (path) latency from cohort() slice
  const cs = slices['cohort()'] ?? {};
  if (cs && warmStartAcceptable(cs)) {
    const cMu = cs.mu_mean;
    const cSigma = cs.sigma_mean;
    const cOnset = cs.onset_mean;
    if (cMu != null && cSigma != null) {
      result.cohortMu = Number(cMu);
      result.cohortSigma = Number(cSigma);
      result.cohortOnset = cOnset != null ? Number(cOnset) : null;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Engorge graph edges — inject `_bayes_evidence` and `_bayes_priors`
 * from parameter files onto each edge that has a parameter file.
 *
 * Mutates `graphData.edges` in place. Edges without a matching
 * parameter file are left unchanged.
 *
 * @param graphData   The graph data object (must have an `edges` array).
 * @param parameterFiles  Record keyed by either `parameter-{id}` or
 *   bare `{id}`, with parameter file data as values.
 */
export function engorgeGraphEdges(
  graphData: any,
  parameterFiles: Record<string, any>,
): void {
  const edges: any[] = graphData?.edges;
  if (!Array.isArray(edges)) return;

  for (const edge of edges) {
    const paramId: string | undefined = edge.p?.id;
    if (!paramId) continue;

    // Look up param file — try both prefixed and bare keys
    const pf: Record<string, any> | undefined =
      parameterFiles[`parameter-${paramId}`] as Record<string, any> | undefined
      ?? parameterFiles[paramId] as Record<string, any> | undefined;
    if (!pf) continue;

    // Build _bayes_evidence
    edge._bayes_evidence = buildEvidence(pf);

    // Resolve probability prior
    const prob = resolveProbPrior(pf);

    // Resolve latency prior
    const lat = resolveLatencyPrior(edge, pf);

    // Resolve warm-start extras
    const extras = resolveWarmStartExtras(edge, pf);

    // Engorge `_posteriorSlices` from the parameter file's `posterior`
    // (doc 73b §3.2a (ii) — request-graph engorgement only).
    //
    // Today's BE consumer (`epistemic_bands.py:148`) walks the multi-context
    // slice library plus `fit_history` for time-axis epistemic bands. Before
    // doc 73b, that data lived persistently on the live edge via
    // `mappingConfigurations.ts` Flow G. Stage 4(b) removes the persistent
    // stash; Stage 4(a) replaces it with a per-call engorgement onto the
    // request-graph copy. The shape mirrors what Flow G used to write so
    // the BE consumer remains unchanged.
    //
    // Engorgement is presence-conditional (§3.2a (ii)): the field is written
    // when the parameter file's posterior is present, regardless of which
    // source the selector / quality gate has promoted.
    const fileposterior = (pf as any).posterior;
    if (fileposterior && typeof fileposterior === 'object' && fileposterior.slices) {
      if (!edge.p || typeof edge.p !== 'object') {
        edge.p = {};
      }
      edge.p._posteriorSlices = {
        slices: fileposterior.slices,
        fitted_at: fileposterior.fitted_at,
        fingerprint: fileposterior.fingerprint,
        hdi_level: fileposterior.hdi_level,
        prior_tier: fileposterior.prior_tier,
        surprise_z: fileposterior.surprise_z,
        ...(fileposterior.fit_history ? { fit_history: fileposterior.fit_history } : {}),
      };
    }

    // Build _bayes_priors
    edge._bayes_priors = {
      prob_alpha: prob.alpha,
      prob_beta: prob.beta,
      prob_source: prob.source,
      latency_onset: lat.onset,
      latency_mu: lat.mu,
      latency_sigma: lat.sigma,
      latency_source: lat.source,
      onset_uncertainty: lat.onsetUncertainty,
      kappa: extras.kappa,
      cohort_mu: extras.cohortMu,
      cohort_sigma: extras.cohortSigma,
      cohort_onset: extras.cohortOnset,
      // onset_observations come from snapshot DB, not param files.
      // Always null in the file-based evidence path.
      onset_observations: null,
    } satisfies BayesPriors;
  }
}

/**
 * Build a Bayes submission snapshot from a working graph.
 *
 * The returned graph is a deep clone with any leaked runtime-only Bayes
 * fields stripped before engorging. Callers must send this snapshot to the
 * backend instead of mutating the live editor graph.
 */
export function buildEngorgedBayesGraphSnapshot(
  graphData: any,
  parameterFiles: Record<string, any>,
): any {
  const graphSnapshot = cloneGraphWithoutBayesRuntimeFields(graphData);
  engorgeGraphEdges(graphSnapshot, parameterFiles);
  return graphSnapshot;
}
