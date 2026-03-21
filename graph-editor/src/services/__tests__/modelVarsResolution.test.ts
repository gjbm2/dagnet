import { describe, it, expect } from 'vitest';
import {
  resolveActiveModelVars,
  effectivePreference,
  promoteModelVars,
  applyPromotion,
} from '../modelVarsResolution';
import type { ModelVarsEntry, ProbabilityParam } from '../../types';

// ── Fixtures ────────────────────────────────────────────────────────────────

const analyticEntry: ModelVarsEntry = {
  source: 'analytic',
  source_at: '20-Mar-26',
  probability: { mean: 0.12, stdev: 0.03 },
  latency: {
    mu: 2.5,
    sigma: 0.8,
    t95: 45,
    onset_delta_days: 3,
    path_mu: 3.1,
    path_sigma: 0.9,
    path_t95: 60,
  },
};

const bayesianGated: ModelVarsEntry = {
  source: 'bayesian',
  source_at: '21-Mar-26',
  probability: { mean: 0.15, stdev: 0.02 },
  latency: {
    mu: 2.3,
    sigma: 0.7,
    t95: 40,
    onset_delta_days: 2.5,
    path_mu: 2.9,
    path_sigma: 0.85,
    path_t95: 55,
  },
  quality: {
    rhat: 1.01,
    ess: 800,
    divergences: 0,
    evidence_grade: 3,
    gate_passed: true,
  },
};

const bayesianFailed: ModelVarsEntry = {
  ...bayesianGated,
  quality: {
    rhat: 1.15,
    ess: 120,
    divergences: 5,
    evidence_grade: 1,
    gate_passed: false,
  },
};

const manualEntry: ModelVarsEntry = {
  source: 'manual',
  source_at: '21-Mar-26',
  probability: { mean: 0.20, stdev: 0.05 },
  latency: {
    mu: 2.0,
    sigma: 0.6,
    t95: 35,
    onset_delta_days: 2,
  },
};

const allThree = [analyticEntry, bayesianGated, manualEntry];

// ── effectivePreference ─────────────────────────────────────────────────────

describe('effectivePreference', () => {
  it('should use edge preference when present', () => {
    expect(effectivePreference('manual', 'bayesian')).toBe('manual');
  });

  it('should fall back to graph preference when edge is undefined', () => {
    expect(effectivePreference(undefined, 'analytic')).toBe('analytic');
  });

  it('should default to best_available when both are undefined', () => {
    expect(effectivePreference(undefined, undefined)).toBe('best_available');
  });

  it('should prefer edge over graph even when edge is best_available', () => {
    expect(effectivePreference('best_available', 'bayesian')).toBe('best_available');
  });
});

// ── resolveActiveModelVars ──────────────────────────────────────────────────

describe('resolveActiveModelVars', () => {
  describe('best_available preference', () => {
    it('should select bayesian when gated and present', () => {
      const result = resolveActiveModelVars(allThree, 'best_available');
      expect(result?.source).toBe('bayesian');
      expect(result?.probability.mean).toBe(0.15);
    });

    it('should fall back to analytic when bayesian fails gate', () => {
      const entries = [analyticEntry, bayesianFailed, manualEntry];
      const result = resolveActiveModelVars(entries, 'best_available');
      expect(result?.source).toBe('analytic');
      expect(result?.probability.mean).toBe(0.12);
    });

    it('should select analytic when no bayesian entry exists', () => {
      const result = resolveActiveModelVars([analyticEntry], 'best_available');
      expect(result?.source).toBe('analytic');
    });
  });

  describe('bayesian preference', () => {
    it('should select bayesian when gated', () => {
      const result = resolveActiveModelVars(allThree, 'bayesian');
      expect(result?.source).toBe('bayesian');
    });

    it('should fall back to analytic when bayesian fails gate', () => {
      const entries = [analyticEntry, bayesianFailed];
      const result = resolveActiveModelVars(entries, 'bayesian');
      expect(result?.source).toBe('analytic');
    });

    it('should fall back to analytic when no bayesian entry exists', () => {
      const result = resolveActiveModelVars([analyticEntry], 'bayesian');
      expect(result?.source).toBe('analytic');
    });
  });

  describe('analytic preference', () => {
    it('should select analytic even when gated bayesian is available', () => {
      const result = resolveActiveModelVars(allThree, 'analytic');
      expect(result?.source).toBe('analytic');
      expect(result?.probability.mean).toBe(0.12);
    });

    it('should return undefined when no analytic entry exists', () => {
      const result = resolveActiveModelVars([bayesianGated, manualEntry], 'analytic');
      expect(result).toBeUndefined();
    });
  });

  describe('manual preference', () => {
    it('should select manual entry when present', () => {
      const result = resolveActiveModelVars(allThree, 'manual');
      expect(result?.source).toBe('manual');
      expect(result?.probability.mean).toBe(0.20);
    });

    it('should fall through to best_available when no manual entry exists', () => {
      const entries = [analyticEntry, bayesianGated];
      const result = resolveActiveModelVars(entries, 'manual');
      expect(result?.source).toBe('bayesian');
    });

    it('should fall through to analytic when no manual and bayesian fails gate', () => {
      const entries = [analyticEntry, bayesianFailed];
      const result = resolveActiveModelVars(entries, 'manual');
      expect(result?.source).toBe('analytic');
    });
  });

  describe('edge cases', () => {
    it('should return undefined for undefined model_vars', () => {
      expect(resolveActiveModelVars(undefined, 'best_available')).toBeUndefined();
    });

    it('should return undefined for empty model_vars array', () => {
      expect(resolveActiveModelVars([], 'best_available')).toBeUndefined();
    });

    it('should return undefined when only manual exists and preference is analytic', () => {
      expect(resolveActiveModelVars([manualEntry], 'analytic')).toBeUndefined();
    });

    it('should handle bayesian entry without quality block as ungated', () => {
      const noQuality: ModelVarsEntry = {
        source: 'bayesian',
        source_at: '21-Mar-26',
        probability: { mean: 0.15, stdev: 0.02 },
      };
      const result = resolveActiveModelVars([analyticEntry, noQuality], 'best_available');
      expect(result?.source).toBe('analytic');
    });
  });
});

// ── promoteModelVars ────────────────────────────────────────────────────────

describe('promoteModelVars', () => {
  it('should return undefined for undefined entry', () => {
    expect(promoteModelVars(undefined)).toBeUndefined();
  });

  it('should promote probability fields', () => {
    const result = promoteModelVars(analyticEntry);
    expect(result?.mean).toBe(0.12);
    expect(result?.stdev).toBe(0.03);
    expect(result?.activeSource).toBe('analytic');
  });

  it('should promote latency fields when present', () => {
    const result = promoteModelVars(bayesianGated);
    expect(result?.latency?.mu).toBe(2.3);
    expect(result?.latency?.sigma).toBe(0.7);
    expect(result?.latency?.t95).toBe(40);
    expect(result?.latency?.onset_delta_days).toBe(2.5);
    expect(result?.latency?.path_mu).toBe(2.9);
    expect(result?.latency?.path_sigma).toBe(0.85);
    expect(result?.latency?.path_t95).toBe(55);
  });

  it('should omit latency when entry has no latency block', () => {
    const probOnly: ModelVarsEntry = {
      source: 'analytic',
      source_at: '20-Mar-26',
      probability: { mean: 0.5, stdev: 0.1 },
    };
    const result = promoteModelVars(probOnly);
    expect(result?.mean).toBe(0.5);
    expect(result?.latency).toBeUndefined();
  });

  it('should omit path-level fields when not present in entry', () => {
    const result = promoteModelVars(manualEntry);
    expect(result?.latency?.mu).toBe(2.0);
    expect(result?.latency?.path_mu).toBeUndefined();
    expect(result?.latency?.path_sigma).toBeUndefined();
    expect(result?.latency?.path_t95).toBeUndefined();
  });
});

// ── applyPromotion ──────────────────────────────────────────────────────────

describe('applyPromotion', () => {
  it('should write promoted scalars onto ProbabilityParam', () => {
    const p: ProbabilityParam = {
      mean: 0,
      stdev: 0,
      latency: {
        mu: 0, sigma: 0, t95: 0, onset_delta_days: 0,
      },
      model_vars: [analyticEntry, bayesianGated],
    };

    const source = applyPromotion(p, undefined);

    expect(source).toBe('bayesian');
    expect(p.mean).toBe(0.15);
    expect(p.stdev).toBe(0.02);
    expect(p.latency?.mu).toBe(2.3);
    expect(p.latency?.sigma).toBe(0.7);
    expect(p.latency?.t95).toBe(40);
    expect(p.latency?.onset_delta_days).toBe(2.5);
    expect(p.latency?.path_mu).toBe(2.9);
    expect(p.latency?.path_sigma).toBe(0.85);
    expect(p.latency?.path_t95).toBe(55);
  });

  it('should respect edge-level model_source_preference', () => {
    const p: ProbabilityParam = {
      mean: 0,
      stdev: 0,
      latency: { mu: 0, sigma: 0, t95: 0, onset_delta_days: 0 },
      model_vars: [analyticEntry, bayesianGated],
      model_source_preference: 'analytic',
    };

    const source = applyPromotion(p, 'bayesian');

    expect(source).toBe('analytic');
    expect(p.mean).toBe(0.12);
  });

  it('should respect graph-level preference when edge has none', () => {
    const p: ProbabilityParam = {
      mean: 0,
      stdev: 0,
      model_vars: [analyticEntry, bayesianGated],
    };

    const source = applyPromotion(p, 'analytic');

    expect(source).toBe('analytic');
    expect(p.mean).toBe(0.12);
  });

  it('should return undefined and not mutate when model_vars is empty', () => {
    const p: ProbabilityParam = {
      mean: 0.99,
      stdev: 0.01,
    };

    const source = applyPromotion(p, undefined);

    expect(source).toBeUndefined();
    expect(p.mean).toBe(0.99);
    expect(p.stdev).toBe(0.01);
  });

  it('should not write latency when ProbabilityParam has no latency block', () => {
    const p: ProbabilityParam = {
      mean: 0,
      stdev: 0,
      model_vars: [bayesianGated],
    };

    const source = applyPromotion(p, undefined);

    expect(source).toBe('bayesian');
    expect(p.mean).toBe(0.15);
    expect(p.latency).toBeUndefined();
  });
});
