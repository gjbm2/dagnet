/**
 * asat posterior resolution — blind integration tests (doc 27 §7).
 *
 * Tests the complete asat posterior path: fit_history selection,
 * synthetic posterior construction, and projection to graph edge shapes.
 *
 * Written from the doc 27 specification, not from implementation code.
 */

import { describe, it, expect } from 'vitest';
import type { Posterior, SlicePosteriorEntry, FitHistoryEntry } from '../../types';
import {
  resolveAsatPosterior,
  projectProbabilityPosterior,
  projectLatencyPosterior,
  resolvePosteriorSlice,
  buildSliceKey,
  detectTemporalMode,
} from '../posteriorSliceResolution';

// ── Fixture builders ────────────────────────────────────────────────────────

/** Build a full SlicePosteriorEntry with all fields populated. */
function makeFullSlice(overrides: Partial<SlicePosteriorEntry> = {}): SlicePosteriorEntry {
  return {
    alpha: 43.0,
    beta: 119.5,
    p_hdi_lower: 0.22,
    p_hdi_upper: 0.33,
    mu_mean: 1.87,
    mu_sd: 0.05,
    sigma_mean: 0.37,
    sigma_sd: 0.02,
    onset_mean: 5.3,
    onset_sd: 0.8,
    hdi_t95_lower: 22.1,
    hdi_t95_upper: 36.8,
    onset_mu_corr: -0.42,
    ess: 1100,
    rhat: 1.002,
    divergences: 0,
    evidence_grade: 3,
    provenance: 'bayesian',
    ...overrides,
  };
}

/** Build a full-fidelity FitHistoryEntry. */
function makeFullEntry(
  fittedAt: string,
  fingerprint: string,
  sliceOverrides: Record<string, Partial<SlicePosteriorEntry>> = {},
): FitHistoryEntry {
  const slices: Record<string, SlicePosteriorEntry> = {};
  for (const [key, overrides] of Object.entries(sliceOverrides)) {
    slices[key] = makeFullSlice(overrides);
  }
  if (Object.keys(slices).length === 0) {
    slices['window()'] = makeFullSlice();
  }
  return {
    fitted_at: fittedAt,
    fingerprint,
    hdi_level: 0.9,
    prior_tier: 'direct_history',
    slices,
  };
}

/** Build a legacy SlimSlice-shaped entry (alpha/beta only). */
function makeLegacyEntry(fittedAt: string, fingerprint: string): FitHistoryEntry {
  return {
    fitted_at: fittedAt,
    fingerprint,
    slices: {
      'window()': { alpha: 70, beta: 190 } as any,
    },
  };
}

/** Build a Posterior with configurable fit_history. */
function makePosterior(opts: {
  fitted_at?: string;
  fit_history?: FitHistoryEntry[];
  sliceOverrides?: Partial<SlicePosteriorEntry>;
} = {}): Posterior {
  return {
    fitted_at: opts.fitted_at ?? '1-Mar-26',
    fingerprint: 'current-fp',
    hdi_level: 0.9,
    prior_tier: 'direct_history',
    slices: {
      'window()': makeFullSlice(opts.sliceOverrides),
      'cohort()': makeFullSlice({ alpha: 38, beta: 112, mu_mean: 2.41 }),
    },
    ...(opts.fit_history ? { fit_history: opts.fit_history } : {}),
  };
}

// ── A. asat selection (on-or-before semantics) ──────────────────────────────

describe('resolveAsatPosterior — selection', () => {
  it('A1: should select most recent fit on or before the asat date', () => {
    const posterior = makePosterior({
      fitted_at: '1-Mar-26',
      fit_history: [
        makeFullEntry('1-Jan-26', 'fp-jan'),
        makeFullEntry('15-Jan-26', 'fp-jan15'),
        makeFullEntry('1-Feb-26', 'fp-feb'),
      ],
    });

    const result = resolveAsatPosterior(posterior, '20-Jan-26');
    expect(result).toBeDefined();
    expect(result!.fitted_at).toBe('15-Jan-26');
    expect(result!.fingerprint).toBe('fp-jan15');
  });

  it('A2: should return current posterior when fitted_at <= asat', () => {
    const posterior = makePosterior({ fitted_at: '1-Mar-26' });

    const result = resolveAsatPosterior(posterior, '15-Mar-26');
    expect(result).toBeDefined();
    expect(result!.fitted_at).toBe('1-Mar-26');
    expect(result!.fingerprint).toBe('current-fp');
    // Should be the actual current posterior, not a synthetic
    expect(result).toBe(posterior);
  });

  it('A3: should return undefined when no fit exists before asat date', () => {
    const posterior = makePosterior({
      fitted_at: '1-Mar-26',
      fit_history: [
        makeFullEntry('15-Jan-26', 'fp-jan15'),
        makeFullEntry('1-Feb-26', 'fp-feb'),
      ],
    });

    const result = resolveAsatPosterior(posterior, '10-Jan-26');
    expect(result).toBeUndefined();
  });

  it('A4: should return undefined when fit_history is empty and current posterior is after asat', () => {
    const posterior = makePosterior({ fitted_at: '1-Mar-26' });

    const result = resolveAsatPosterior(posterior, '15-Feb-26');
    expect(result).toBeUndefined();
  });

  it('A5: should match on exact date', () => {
    const posterior = makePosterior({
      fitted_at: '1-Mar-26',
      fit_history: [
        makeFullEntry('15-Jan-26', 'fp-exact'),
      ],
    });

    const result = resolveAsatPosterior(posterior, '15-Jan-26');
    expect(result).toBeDefined();
    expect(result!.fitted_at).toBe('15-Jan-26');
  });

  it('A6: should prefer current posterior over fit_history when both match', () => {
    const posterior = makePosterior({
      fitted_at: '15-Jan-26',
      fit_history: [
        makeFullEntry('1-Jan-26', 'fp-history'),
      ],
    });

    const result = resolveAsatPosterior(posterior, '15-Jan-26');
    expect(result).toBeDefined();
    // Should return the current posterior (identity), not the history entry
    expect(result).toBe(posterior);
    expect(result!.fingerprint).toBe('current-fp');
  });
});

// ── B. Synthetic posterior construction ──────────────────────────────────────

describe('resolveAsatPosterior — synthetic posterior shape', () => {
  it('B1: should return an object with Posterior shape', () => {
    const posterior = makePosterior({
      fitted_at: '1-Mar-26',
      fit_history: [
        makeFullEntry('15-Jan-26', 'fp-jan15'),
      ],
    });

    const result = resolveAsatPosterior(posterior, '20-Jan-26');
    expect(result).toBeDefined();
    expect(result!.fitted_at).toBe('15-Jan-26');
    expect(result!.fingerprint).toBe('fp-jan15');
    expect(result!.hdi_level).toBe(0.9);
    expect(result!.prior_tier).toBe('direct_history');
    expect(result!.slices).toBeDefined();
    expect(result!.slices['window()']).toBeDefined();
  });

  it('B2: should use the history entry slices, not current posterior slices', () => {
    const historySlice = makeFullSlice({ alpha: 99, beta: 999 });
    const posterior = makePosterior({
      fitted_at: '1-Mar-26',
      fit_history: [{
        fitted_at: '15-Jan-26',
        fingerprint: 'fp-jan15',
        hdi_level: 0.9,
        prior_tier: 'direct_history',
        slices: { 'window()': historySlice },
      }],
    });

    const result = resolveAsatPosterior(posterior, '20-Jan-26');
    expect(result!.slices['window()'].alpha).toBe(99);
    expect(result!.slices['window()'].beta).toBe(999);
  });

  it('B4: should fall back to current posterior metadata when entry lacks hdi_level/prior_tier', () => {
    const posterior = makePosterior({
      fitted_at: '1-Mar-26',
      fit_history: [
        makeLegacyEntry('15-Jan-26', 'fp-legacy'),
      ],
    });

    const result = resolveAsatPosterior(posterior, '20-Jan-26');
    expect(result).toBeDefined();
    // Legacy entries lack hdi_level/prior_tier — should fall back to current posterior's values
    expect(result!.hdi_level).toBe(0.9);
    expect(result!.prior_tier).toBe('direct_history');
  });
});

// ── C. Projection round-trip (full-fidelity entry) ──────────────────────────

describe('resolveAsatPosterior — projection round-trip (full fidelity)', () => {
  const historyEntry = makeFullEntry('15-Jan-26', 'fp-jan15', {
    'window()': { alpha: 50, beta: 150, p_hdi_lower: 0.25, p_hdi_upper: 0.38, ess: 900, rhat: 1.005, divergences: 0, evidence_grade: 3, provenance: 'bayesian' },
    'cohort()': { alpha: 40, beta: 120, p_hdi_lower: 0.22, p_hdi_upper: 0.36, mu_mean: 2.5, mu_sd: 0.1, sigma_mean: 0.5, sigma_sd: 0.03 },
  });

  const posterior = makePosterior({
    fitted_at: '1-Mar-26',
    fit_history: [historyEntry],
  });

  it('C1: should project historical ProbabilityPosterior correctly', () => {
    const resolved = resolveAsatPosterior(posterior, '20-Jan-26');
    expect(resolved).toBeDefined();

    const prob = projectProbabilityPosterior(resolved!, '');
    expect(prob).toBeDefined();
    expect(prob!.alpha).toBe(50);
    expect(prob!.beta).toBe(150);
    expect(prob!.hdi_lower).toBe(0.25);
    expect(prob!.hdi_upper).toBe(0.38);
    expect(prob!.ess).toBe(900);
    expect(prob!.rhat).toBe(1.005);
    expect(prob!.fitted_at).toBe('15-Jan-26');
    expect(prob!.fingerprint).toBe('fp-jan15');
  });

  it('C2: should project historical LatencyPosterior correctly', () => {
    const resolved = resolveAsatPosterior(posterior, '20-Jan-26');
    const lat = projectLatencyPosterior(resolved!, '');
    expect(lat).toBeDefined();
    expect(lat!.mu_mean).toBe(1.87);
    expect(lat!.mu_sd).toBe(0.05);
    expect(lat!.sigma_mean).toBe(0.37);
    expect(lat!.sigma_sd).toBe(0.02);
    expect(lat!.hdi_t95_lower).toBe(22.1);
    expect(lat!.hdi_t95_upper).toBe(36.8);
  });

  it('C3: should carry fitted_at/fingerprint from the historical entry', () => {
    const resolved = resolveAsatPosterior(posterior, '20-Jan-26');
    const prob = projectProbabilityPosterior(resolved!, '');
    expect(prob!.fitted_at).toBe('15-Jan-26');
    expect(prob!.fingerprint).toBe('fp-jan15');
    // Must NOT be the current posterior's metadata
    expect(prob!.fitted_at).not.toBe('1-Mar-26');
  });
});

// ── D. Projection round-trip (legacy entry) ─────────────────────────────────

describe('resolveAsatPosterior — projection round-trip (legacy entry)', () => {
  const posterior = makePosterior({
    fitted_at: '1-Mar-26',
    fit_history: [
      makeLegacyEntry('15-Jan-26', 'fp-legacy'),
    ],
  });

  it('D1: should project ProbabilityPosterior with alpha/beta but no HDI', () => {
    const resolved = resolveAsatPosterior(posterior, '20-Jan-26');
    expect(resolved).toBeDefined();

    const prob = projectProbabilityPosterior(resolved!, '');
    expect(prob).toBeDefined();
    expect(prob!.alpha).toBe(70);
    expect(prob!.beta).toBe(190);
    // Legacy entries lack p_hdi_lower/upper — these pass through as undefined
    expect(prob!.hdi_lower).toBeUndefined();
    expect(prob!.hdi_upper).toBeUndefined();
  });

  it('D3: should return undefined LatencyPosterior when legacy entry has no latency fields', () => {
    const resolved = resolveAsatPosterior(posterior, '20-Jan-26');
    const lat = projectLatencyPosterior(resolved!, '');
    // Legacy entry has no mu_mean — projectLatencyPosterior returns undefined
    expect(lat).toBeUndefined();
  });
});

// ── E. Absence (strict — no fallback) ───────────────────────────────────────

describe('resolveAsatPosterior — strict no-fallback', () => {
  it('E1: projectProbabilityPosterior returns undefined when no fit available', () => {
    const posterior = makePosterior({ fitted_at: '1-Mar-26' });
    const resolved = resolveAsatPosterior(posterior, '15-Feb-26');
    expect(resolved).toBeUndefined();
    const prob = projectProbabilityPosterior(resolved, '');
    expect(prob).toBeUndefined();
  });

  it('E2: projectLatencyPosterior returns undefined when no fit available', () => {
    const posterior = makePosterior({ fitted_at: '1-Mar-26' });
    const resolved = resolveAsatPosterior(posterior, '15-Feb-26');
    expect(resolved).toBeUndefined();
    const lat = projectLatencyPosterior(resolved, '');
    expect(lat).toBeUndefined();
  });

  it('E3: should never return current posterior when fitted_at > asat_date', () => {
    // Current posterior is 1-Mar-26, history has only 1-Feb-26
    // asat is 15-Jan-26 — before all entries
    const posterior = makePosterior({
      fitted_at: '1-Mar-26',
      fit_history: [
        makeFullEntry('1-Feb-26', 'fp-feb'),
      ],
    });

    const result = resolveAsatPosterior(posterior, '15-Jan-26');
    expect(result).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// F. Slice key construction (doc 21 §2.2, doc 25 §2)
// ══════════════════════════════════════════════════════════════════════════════

describe('buildSliceKey — DSL to slice key mapping', () => {
  it('F1: should map bare window DSL to window()', () => {
    expect(buildSliceKey('from(a).to(b).window(1-Jan-25:1-Mar-25)')).toBe('window()');
  });

  it('F2: should map bare cohort DSL to cohort()', () => {
    expect(buildSliceKey('from(a).to(b).cohort(anchor,1-Jan-25:1-Mar-25)')).toBe('cohort()');
  });

  it('F3: should map empty/undefined DSL to window()', () => {
    expect(buildSliceKey('')).toBe('window()');
  });

  it('F4: should include context dimensions in slice key', () => {
    const key = buildSliceKey('from(a).to(b).context(channel:google).window(1-Jan:1-Mar)');
    expect(key).toContain('context(channel:google)');
    expect(key).toContain('window()');
  });

  it('F5: should include context dimensions with cohort', () => {
    const key = buildSliceKey('from(a).to(b).context(channel:influencer).cohort(anchor,1-Jan:1-Mar)');
    expect(key).toContain('context(channel:influencer)');
    expect(key).toContain('cohort()');
  });
});

describe('detectTemporalMode — window vs cohort detection', () => {
  it('F6: should detect window mode for window DSL', () => {
    expect(detectTemporalMode('from(a).to(b).window(1-Jan:1-Mar)')).toBe('window');
  });

  it('F7: should detect cohort mode for cohort DSL', () => {
    expect(detectTemporalMode('from(a).to(b).cohort(anchor,1-Jan:1-Mar)')).toBe('cohort');
  });

  it('F8: should default to window for empty DSL', () => {
    expect(detectTemporalMode('')).toBe('window');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// G. Slice resolution (doc 25 §2.1 — exact match, fallback, no-match)
// ══════════════════════════════════════════════════════════════════════════════

describe('resolvePosteriorSlice — key matching', () => {
  const windowSlice = makeFullSlice({ alpha: 50, beta: 150 });
  const cohortSlice = makeFullSlice({ alpha: 40, beta: 120, mu_mean: 2.5 });
  const contextSlice = makeFullSlice({ alpha: 28, beta: 72 });

  const slices: Record<string, SlicePosteriorEntry> = {
    'window()': windowSlice,
    'cohort()': cohortSlice,
    'window().context(channel:google)': contextSlice,
  };

  it('G1: should exact-match window() for bare window DSL', () => {
    const result = resolvePosteriorSlice(slices, 'from(a).to(b).window(1-Jan:1-Mar)');
    expect(result).toBeDefined();
    expect(result!.alpha).toBe(50);
    expect(result!.beta).toBe(150);
  });

  it('G2: should exact-match cohort() for bare cohort DSL', () => {
    const result = resolvePosteriorSlice(slices, 'from(a).to(b).cohort(anchor,1-Jan:1-Mar)');
    expect(result).toBeDefined();
    expect(result!.alpha).toBe(40);
    expect(result!.beta).toBe(120);
  });

  it('G3: should exact-match context-qualified key', () => {
    const result = resolvePosteriorSlice(slices, 'from(a).to(b).context(channel:google).window(1-Jan:1-Mar)');
    expect(result).toBeDefined();
    expect(result!.alpha).toBe(28);
    expect(result!.beta).toBe(72);
  });

  it('G4: should fall back to aggregate when context key not found', () => {
    // context(channel:influencer) not in slices → falls back to window()
    const result = resolvePosteriorSlice(slices, 'from(a).to(b).context(channel:influencer).window(1-Jan:1-Mar)');
    expect(result).toBeDefined();
    expect(result!.alpha).toBe(50);  // window() aggregate
  });

  it('G5: should return undefined when no slices at all', () => {
    expect(resolvePosteriorSlice(undefined, 'window()')).toBeUndefined();
    expect(resolvePosteriorSlice({}, 'window()')).toBeUndefined();
  });

  it('G6: should return undefined when empty DSL matches window()', () => {
    const result = resolvePosteriorSlice(slices, '');
    expect(result).toBeDefined();
    expect(result!.alpha).toBe(50);  // window() is the default
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// H. Projection — latency with path-level cohort fields (doc 21 §4.4)
// ══════════════════════════════════════════════════════════════════════════════

describe('projectLatencyPosterior — path-level cohort fields', () => {
  it('H1: should include path-level fields from cohort() slice', () => {
    const posterior: Posterior = {
      fitted_at: '1-Mar-26',
      fingerprint: 'fp-test',
      hdi_level: 0.9,
      prior_tier: 'direct_history',
      slices: {
        'window()': makeFullSlice({
          mu_mean: 1.87, mu_sd: 0.05, sigma_mean: 0.37, sigma_sd: 0.02,
          onset_mean: 5.3, onset_sd: 0.8, hdi_t95_lower: 22.1, hdi_t95_upper: 36.8,
          onset_mu_corr: -0.42,
        }),
        'cohort()': makeFullSlice({
          mu_mean: 2.81, mu_sd: 0.12, sigma_mean: 0.58, sigma_sd: 0.06,
          onset_mean: 8.2, onset_sd: 1.1, hdi_t95_lower: 28.4, hdi_t95_upper: 58.7,
          onset_mu_corr: -0.55,
        }),
      },
    };

    const lat = projectLatencyPosterior(posterior, '');
    expect(lat).toBeDefined();

    // Edge-level from window()
    expect(lat!.mu_mean).toBe(1.87);
    expect(lat!.mu_sd).toBe(0.05);
    expect(lat!.sigma_mean).toBe(0.37);
    expect(lat!.onset_delta_days).toBe(5.3);
    expect(lat!.onset_mu_corr).toBe(-0.42);
    expect(lat!.hdi_t95_lower).toBe(22.1);

    // Path-level from cohort()
    expect(lat!.path_mu_mean).toBe(2.81);
    expect(lat!.path_mu_sd).toBe(0.12);
    expect(lat!.path_sigma_mean).toBe(0.58);
    expect(lat!.path_sigma_sd).toBe(0.06);
    expect(lat!.path_onset_delta_days).toBe(8.2);
    expect(lat!.path_onset_sd).toBe(1.1);
    expect(lat!.path_hdi_t95_lower).toBe(28.4);
    expect(lat!.path_hdi_t95_upper).toBe(58.7);
    expect(lat!.path_onset_mu_corr).toBe(-0.55);
    expect(lat!.path_provenance).toBe('bayesian');
  });

  it('H2: should omit path-level fields when no cohort() slice', () => {
    const posterior: Posterior = {
      fitted_at: '1-Mar-26',
      fingerprint: 'fp-test',
      hdi_level: 0.9,
      prior_tier: 'direct_history',
      slices: {
        'window()': makeFullSlice({ mu_mean: 1.87, mu_sd: 0.05 }),
      },
    };

    const lat = projectLatencyPosterior(posterior, '');
    expect(lat).toBeDefined();
    expect(lat!.mu_mean).toBe(1.87);
    expect(lat!.path_mu_mean).toBeUndefined();
    expect(lat!.path_onset_delta_days).toBeUndefined();
  });

  it('H3: should return undefined when window() slice has no latency', () => {
    const posterior: Posterior = {
      fitted_at: '1-Mar-26',
      fingerprint: 'fp-test',
      hdi_level: 0.9,
      prior_tier: 'direct_history',
      slices: {
        'window()': makeFullSlice({ mu_mean: undefined as any, mu_sd: undefined as any }),
      },
    };

    const lat = projectLatencyPosterior(posterior, '');
    expect(lat).toBeUndefined();
  });
});

describe('projectProbabilityPosterior — path-level cohort fields', () => {
  it('H4: should include path-level probability from cohort() slice', () => {
    const posterior: Posterior = {
      fitted_at: '1-Mar-26',
      fingerprint: 'fp-test',
      hdi_level: 0.9,
      prior_tier: 'direct_history',
      slices: {
        'window()': makeFullSlice({ alpha: 43, beta: 119.5, p_hdi_lower: 0.22, p_hdi_upper: 0.33 }),
        'cohort()': makeFullSlice({ alpha: 38, beta: 112, p_hdi_lower: 0.20, p_hdi_upper: 0.35 }),
      },
    };

    const prob = projectProbabilityPosterior(posterior, '');
    expect(prob).toBeDefined();

    // Edge-level from window()
    expect(prob!.alpha).toBe(43);
    expect(prob!.beta).toBe(119.5);
    expect(prob!.hdi_lower).toBe(0.22);

    // Path-level from cohort()
    expect(prob!.cohort_alpha).toBe(38);
    expect(prob!.cohort_beta).toBe(112);
    expect(prob!.cohort_hdi_lower).toBe(0.20);
    expect(prob!.cohort_hdi_upper).toBe(0.35);
  });

  it('H5: should omit path-level fields when no cohort() slice', () => {
    const posterior: Posterior = {
      fitted_at: '1-Mar-26',
      fingerprint: 'fp-test',
      hdi_level: 0.9,
      prior_tier: 'direct_history',
      slices: {
        'window()': makeFullSlice({ alpha: 43, beta: 119.5 }),
      },
    };

    const prob = projectProbabilityPosterior(posterior, '');
    expect(prob).toBeDefined();
    expect(prob!.alpha).toBe(43);
    expect(prob!.cohort_alpha).toBeUndefined();
  });
});
