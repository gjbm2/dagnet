/**
 * Per-edge diagnostic record for the FE topo pass.
 *
 * Built up as the per-edge loop in `enhanceGraphLatencies` walks each emission
 * site, then formatted and emitted as a single `addChild` entry under the
 * parent FE_TOPO_ENHANCE operation. Captures *why* each value landed where it
 * did — provenance tag + optional reason string — so a user staring at a
 * suspicious `model_vars[analytic].latency.sigma=0.5` can correlate it back
 * to "defaulted because mean lag undefined" rather than "fitted".
 *
 * Two output detail levels controlled by the caller's `isTrace` flag:
 *   - `format(false)` — model_vars + chosen blend output, one block per edge
 *   - `format(true)`  — adds per-cascade candidate breakdown and per-step
 *                       blend math (m0_eff, w_evidence, etc.)
 *
 * Allocation is gated at the call site by `sessionLogService.isLevelEnabled`,
 * so when threshold is at info or above the record is never built. The class
 * itself does no logging — pure builder.
 */

export type ProvenanceTag =
  | 'fitted'                    // empirical fit, quality OK
  | 'defaulted'                 // one of the 8 LATENCY_DEFAULT_SIGMA fallbacks; reason string carries which
  | 'pulled_to_t95'             // tail-pulled by path_t95 constraint
  | 'inherited_upstream'        // copied from nodePathMu/nodePathSigma
  | 'weighted_aggregate'        // Σ(n × stat) / Σn from cohorts (with recency weight where applied)
  | 'cascade_anchor_empirical'  // path_mu/sigma cascade branch (a)
  | 'cascade_iterative_fw'      // (b)
  | 'cascade_passthrough'       // (c)
  | 'cascade_self_seed'         // (d)
  | 'cascade_unset'             // path_mu/sigma was never written
  | 'evidence_blended'          // Step 2 blend output
  | 'evidence_fallback'         // Step 2 fallback to evidence-only mean
  | 'forecast_fallback'         // Step 2 fallback to upstream forecast mean
  | 'override_user'             // user-locked value
  | 'unknown';

interface FieldRecord {
  value: number | undefined;
  src: ProvenanceTag;
  reason?: string;
}

export interface PathCascadeCandidates {
  a_anchor_empirical?: {
    mu?: number; sigma?: number; fit_ok?: boolean;
    anchor_median?: number; anchor_mean?: number; w_total?: number;
  };
  b_iterative_fw?: {
    mu?: number; sigma?: number;
    upstream_mu?: number; upstream_sigma?: number;
    subject_mu?: number; subject_sigma?: number;
  };
  c_passthrough?: { mu?: number; sigma?: number };
  d_self_seed?: { mu?: number; sigma?: number };
}

export interface BlendBreakdown {
  // inputs
  m0?: number;                       // forecast_mean from model_vars
  n_baseline?: number;
  lambda?: number;
  evidence_mean?: number;
  evidence_n?: number;
  evidence_k?: number;
  completeness?: number;
  // intermediate
  completeness_pow?: number;
  n_eff?: number;
  m0_eff?: number;
  w_evidence?: number;
  per_day_blend_used?: boolean;
  per_day_count?: number;
  // output
  blended_mean?: number;
  blended_stdev?: number;
  blend_method?: 'canonical-blend' | 'evidence-fallback' | 'forecast-fallback' | string;
}

type ProbField = 'mean' | 'stdev' | 'alpha' | 'beta' | 'n_effective';
type LatField = 'mu' | 'sigma' | 'onset_delta_days' | 't95' | 'completeness';
type PathField = 'path_mu' | 'path_sigma' | 'path_onset_delta_days';

export class EdgeDiagnostic {
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;

  readonly probability: Partial<Record<ProbField, FieldRecord>> = {};
  readonly latency: Partial<Record<LatField | PathField, FieldRecord>> = {};
  pathCascadeChosen?: 'anchor_empirical' | 'iterative_fw' | 'passthrough' | 'self_seed' | 'unset';
  pathCascadeCandidates?: PathCascadeCandidates;
  blend: BlendBreakdown = {};

  // Context
  cohortsInPool?: number;
  isWindowMode?: boolean;
  latencyEnabled?: boolean;
  pathOnsetDays?: number;

  constructor(edgeId: string, fromNodeId: string, toNodeId: string) {
    this.edgeId = edgeId;
    this.fromNodeId = fromNodeId;
    this.toNodeId = toNodeId;
  }

  setProb(field: ProbField, value: number | undefined, src: ProvenanceTag, reason?: string): void {
    this.probability[field] = { value, src, ...(reason ? { reason } : {}) };
  }

  setLat(field: LatField, value: number | undefined, src: ProvenanceTag, reason?: string): void {
    this.latency[field] = { value, src, ...(reason ? { reason } : {}) };
  }

  setPath(field: PathField, value: number | undefined, src: ProvenanceTag, reason?: string): void {
    this.latency[field] = { value, src, ...(reason ? { reason } : {}) };
  }

  setPathCascade(
    chosen: 'anchor_empirical' | 'iterative_fw' | 'passthrough' | 'self_seed' | 'unset',
    candidates: PathCascadeCandidates,
  ): void {
    this.pathCascadeChosen = chosen;
    this.pathCascadeCandidates = candidates;
  }

  setBlend(b: Partial<BlendBreakdown>): void {
    Object.assign(this.blend, b);
  }

  setContext(ctx: {
    cohortsInPool?: number;
    isWindowMode?: boolean;
    latencyEnabled?: boolean;
    pathOnsetDays?: number;
  }): void {
    if (ctx.cohortsInPool !== undefined) this.cohortsInPool = ctx.cohortsInPool;
    if (ctx.isWindowMode !== undefined) this.isWindowMode = ctx.isWindowMode;
    if (ctx.latencyEnabled !== undefined) this.latencyEnabled = ctx.latencyEnabled;
    if (ctx.pathOnsetDays !== undefined) this.pathOnsetDays = ctx.pathOnsetDays;
  }

  /**
   * Single-line headline shown in the collapsed log row. Highlights anything
   * non-routine — defaulted σ, cascade branch, blend fallback. When everything
   * looks routine, returns "ok".
   */
  headline(): string {
    const flags: string[] = [];
    if (this.latency.sigma?.src === 'defaulted') {
      flags.push(`σ=DEFAULT(${this.latency.sigma.reason ?? 'unknown'})`);
    }
    if (this.latency.t95?.src === 'pulled_to_t95') flags.push('t95-pulled');
    if (this.pathCascadeChosen && this.pathCascadeChosen !== 'unset') {
      flags.push(`path-via-${this.pathCascadeChosen}`);
    }
    if (this.blend.blend_method && this.blend.blend_method !== 'canonical-blend') {
      flags.push(`blend=${this.blend.blend_method}`);
    }
    return `${this.edgeId}: ${flags.join(', ') || 'ok'}`;
  }

  /**
   * Multi-line details string for the log entry's `details` field. Trace mode
   * adds per-cascade candidates and per-step blend math; debug mode shows
   * just chosen values + provenance tags.
   */
  format(isTrace: boolean): string {
    const fmt = (v: number | undefined, dp = 4): string => v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(dp);
    const fmtSrc = (rec: FieldRecord | undefined): string => {
      if (!rec) return '–';
      return rec.reason ? `${rec.src} (${rec.reason})` : rec.src;
    };
    const lines: string[] = [];

    lines.push(`Edge ${this.edgeId}  (${this.fromNodeId} → ${this.toNodeId})`);
    const ctx = [
      `mode=${this.isWindowMode ? 'window' : 'cohort'}`,
      `latency_enabled=${this.latencyEnabled ?? '–'}`,
      `cohorts_in_pool=${this.cohortsInPool ?? '–'}`,
    ].join('  ');
    lines.push(ctx);
    lines.push('');

    // ── Step 1: model_vars[analytic] ──
    lines.push('── Step 1: model_vars[analytic] ──');
    lines.push('probability:');
    lines.push(`  mean         = ${fmt(this.probability.mean?.value)}    [${fmtSrc(this.probability.mean)}]`);
    lines.push(`  stdev        = ${fmt(this.probability.stdev?.value)}    [${fmtSrc(this.probability.stdev)}]`);
    lines.push(`  alpha/beta   = ${fmt(this.probability.alpha?.value, 2)} / ${fmt(this.probability.beta?.value, 2)}`);
    lines.push(`  n_effective  = ${fmt(this.probability.n_effective?.value, 2)}`);
    lines.push('latency (edge X→Y):');
    const sigmaFlag = this.latency.sigma?.src === 'defaulted' ? ' ⚠' : '';
    lines.push(`  mu                = ${fmt(this.latency.mu?.value)}    [${fmtSrc(this.latency.mu)}]`);
    lines.push(`  sigma             = ${fmt(this.latency.sigma?.value)}    [${fmtSrc(this.latency.sigma)}]${sigmaFlag}`);
    lines.push(`  onset_delta_days  = ${fmt(this.latency.onset_delta_days?.value, 2)}d    [${fmtSrc(this.latency.onset_delta_days)}]`);
    lines.push(`  t95               = ${fmt(this.latency.t95?.value, 2)}d    [${fmtSrc(this.latency.t95)}]`);
    lines.push(`  completeness      = ${fmt(this.latency.completeness?.value)}    [${fmtSrc(this.latency.completeness)}]`);
    lines.push('latency (path A→Y):');
    lines.push(`  path_mu           = ${fmt(this.latency.path_mu?.value)}    [cascade: ${this.pathCascadeChosen ?? '–'}]`);
    lines.push(`  path_sigma        = ${fmt(this.latency.path_sigma?.value)}`);
    lines.push(`  path_onset_days   = ${fmt(this.pathOnsetDays, 2)}d`);

    if (isTrace && this.pathCascadeCandidates) {
      const c = this.pathCascadeCandidates;
      lines.push('  cascade candidates:');
      if (c.a_anchor_empirical) {
        lines.push(`    (a) anchor_empirical: mu=${fmt(c.a_anchor_empirical.mu)} sigma=${fmt(c.a_anchor_empirical.sigma)}  fit_ok=${c.a_anchor_empirical.fit_ok ?? '–'}`);
        lines.push(`        inputs: anchor_median=${fmt(c.a_anchor_empirical.anchor_median, 2)}d  anchor_mean=${fmt(c.a_anchor_empirical.anchor_mean, 2)}d  w_total=${fmt(c.a_anchor_empirical.w_total, 1)}`);
      }
      if (c.b_iterative_fw) {
        lines.push(`    (b) iterative_fw:     mu=${fmt(c.b_iterative_fw.mu)} sigma=${fmt(c.b_iterative_fw.sigma)}`);
        lines.push(`        inputs: upstream(mu=${fmt(c.b_iterative_fw.upstream_mu)} sigma=${fmt(c.b_iterative_fw.upstream_sigma)}) ⊕ subject(mu=${fmt(c.b_iterative_fw.subject_mu)} sigma=${fmt(c.b_iterative_fw.subject_sigma)})`);
      }
      if (c.c_passthrough) {
        lines.push(`    (c) passthrough:      mu=${fmt(c.c_passthrough.mu)} sigma=${fmt(c.c_passthrough.sigma)}`);
      }
      if (c.d_self_seed) {
        lines.push(`    (d) self_seed:        mu=${fmt(c.d_self_seed.mu)} sigma=${fmt(c.d_self_seed.sigma)}`);
      }
    }

    // ── Step 2: scoped blend ──
    lines.push('');
    lines.push('── Step 2: scoped blend (current-answer) ──');
    if (this.blend.blend_method) {
      const perDay = this.blend.per_day_blend_used ? `(per-day, ${this.blend.per_day_count ?? '?'} days)` : '(aggregate)';
      lines.push(`method: ${this.blend.blend_method} ${perDay}`);
      lines.push('inputs:');
      lines.push(`  m0 (forecast_mean)       = ${fmt(this.blend.m0)}`);
      lines.push(`  n_baseline               = ${fmt(this.blend.n_baseline, 1)}`);
      lines.push(`  evidence (mean / n / k)  = ${fmt(this.blend.evidence_mean)} / ${fmt(this.blend.evidence_n, 0)} / ${fmt(this.blend.evidence_k, 0)}`);
      lines.push(`  completeness             = ${fmt(this.blend.completeness)}`);
      if (isTrace) {
        lines.push('intermediate:');
        lines.push(`  completeness_pow         = ${fmt(this.blend.completeness_pow)}`);
        lines.push(`  n_eff                    = ${fmt(this.blend.n_eff, 1)}`);
        lines.push(`  m0_eff = λ·n_baseline·(1−c_pow)  = ${fmt(this.blend.m0_eff, 1)}    λ=${fmt(this.blend.lambda)}`);
        lines.push(`  w_evidence = n_eff / (m0_eff + n_eff)  = ${fmt(this.blend.w_evidence)}`);
      }
      lines.push('output:');
      lines.push(`  blended_mean             = ${fmt(this.blend.blended_mean)}`);
      lines.push(`  blended_stdev            = ${fmt(this.blend.blended_stdev)}`);
    } else {
      lines.push('(blend not run for this edge)');
    }

    return lines.join('\n');
  }
}

/**
 * Map `LagDistributionFit.quality_failure_reason` to a short tag suitable for
 * the EdgeDiagnostic provenance reason field. Returns the reason verbatim if
 * no compaction matches.
 */
export function compactFitReason(reason: string | undefined): string {
  if (!reason) return 'unknown';
  if (reason.includes('Insufficient converters')) return 'insufficient_converters';
  if (reason.includes('Mean lag not available')) return 'mean_missing';
  if (reason.includes('Invalid median lag')) return 'invalid_median';
  if (reason.includes('Invalid sigma')) return 'invalid_sigma';
  if (reason.includes('ratio too low')) return 'ratio_too_low';
  if (reason.includes('ratio too high')) return 'ratio_too_high';
  if (reason.includes('< 1.0')) return 'mean_lt_median';
  if (reason.includes('degenerate')) return 'sigma_degenerate';
  return reason;
}
